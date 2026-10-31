import "server-only";

import { assertDefaultChatWritable } from "./chat-facts";

import type {
  SessionChatInputRequest,
  SessionState,
  Turn,
} from "@microsoft/agent-host-protocol";
import type { AhpClient } from "@microsoft/agent-host-protocol/client";

import {
  awaitAbortableBoundary,
  OperationAbortedError,
  throwIfAborted,
} from "../abort.ts";
import { withAHPClient } from "./client-operation";
import { readChatState, readRootState, withSessionState, withChatState } from "./snapshot";
import { EvidenceCaptureBudget } from "./evidence-budget";
import { verifyPlanEvidence } from "./plan-artifact";
import { readReviewSourceDigest } from "./changeset-enricher";
import type { PlanEvidence } from "./plan-source";
import { getDb } from "../db/schema";
import { claimPlanAnswer, completePlanAnswer } from "../db/plan-answer-store";
import { resolveAuthoritativeGateRevision } from "../orchestrator/gate-revision";

interface PlanAnswer {
  hostUrl: string;
  evidence: PlanEvidence;
  action: "approve" | "feedback";
}
import { AHPStatus, parseAHPStatus } from "./types";
import { buildPlanFeedbackAnswer } from "./answer-value";
import {
  buildCreatePeerChatParams,
  supportsPeerChats,
} from "./peer-chat-core";
import {
  findChatInputEntry,
  hasObservedInputNeeded,
  isInputObservedRemoved,
} from "./input-presence";
import {
  chatTurnStarted,
  chatQueuedMessage,
  chatInputAnswerChanged,
  chatInputCompleted,
  sessionIsArchivedChanged,
} from "./actions";
import {
  dispatchAndConfirm,
  MessageDispatchAmbiguousError,
} from "./dispatch-confirmation";
import {
  createPeerChatWithCleanupOnFailure,
  dispatchPeerChatReviewWithClient,
  disposePeerChatAfterFailure,
  PeerChatCleanupRequiredError,
} from "./peer-review-dispatch";
import {
  assertOperationCurrent,
  getOperationSignal,
  runOperationEffect,
} from "../orchestrator/operation-context";

export { MessageDispatchAmbiguousError } from "./dispatch-confirmation";

const debug = (...args: unknown[]) => {
  if (process.env.AHP_DEBUG) console.info("[ahp:messenger]", ...args);
};

/**
 * Inject a user message into an AHP session.
 *
 * If the session is idle → dispatches chat/turnStarted (starts a new turn).
 * If the session is active → dispatches chat/pendingMessageSet with kind "queued"
 * so the message is delivered after the current turn finishes.
 */
export async function injectMessageWithClient(
  client: AhpClient,
  sessionUri: string,
  message: string,
  signal?: AbortSignal,
  beforeDispatch?: (identity: {
    chatUri: string;
    turnId: string;
    disposablePeerChat: boolean;
    queued?: boolean;
  }) => void,
): Promise<{
  turnId: string;
  chatUri?: string;
  success: boolean;
  queued?: boolean;
}> {
  signal ??= getOperationSignal();
  throwIfAborted(signal);
  assertOperationCurrent("interact", { cardId: sessionUri });
  return withSessionState(client, sessionUri, async (sessionState, access) => {
    if (!sessionState?.defaultChat) {
      debug("No chat channel found for", sessionUri);
      return { turnId: "", success: false };
    }
    const chatUri = sessionState.defaultChat;
    await awaitAbortableBoundary(
      () => assertDefaultChatWritable(client, sessionState),
      signal,
    );
    access.assertCurrent();
    assertOperationCurrent("interact", { cardId: sessionUri });
    const currentState = access.getState();
    if (currentState?.defaultChat !== chatUri) {
      throw new OperationAbortedError("The default chat changed during message setup.");
    }
    const { isInProgress } = parseAHPStatus(currentState.status);
    const messageId = crypto.randomUUID();
    beforeDispatch?.({
      chatUri,
      turnId: messageId,
      disposablePeerChat: false,
      queued: isInProgress,
    });
    await runOperationEffect("interact", () => dispatchAndConfirm(
      client,
      chatUri,
      isInProgress ? chatQueuedMessage(messageId, message) : chatTurnStarted(messageId, message),
      isInProgress
        ? "The queued message may have been dispatched before the transport failed."
        : "The message may have been dispatched before the transport failed.",
      signal,
    ));

    debug(isInProgress ? "Queued message for" : "Injected message into", sessionUri, messageId);
    return { turnId: messageId, chatUri, success: true, ...(isInProgress ? { queued: true } : {}) };
  }, signal);
}

export function injectMessage(
  hostUrl: string,
  sessionUri: string,
  message: string,
  options?: {
    signal?: AbortSignal;
    beforeDispatch?: (identity: {
      chatUri: string;
      turnId: string;
      disposablePeerChat: boolean;
      queued?: boolean;
    }) => void;
  },
): Promise<{
  turnId: string;
  chatUri?: string;
  success: boolean;
  queued?: boolean;
}> {
  const signal = options?.signal ?? getOperationSignal();
  assertOperationCurrent("interact", { hostUrl, cardId: sessionUri });
  return withAHPClient(
    hostUrl,
    (client) =>
      injectMessageWithClient(
        client,
        sessionUri,
        message,
        signal,
        options?.beforeDispatch,
      ),
    signal,
  );
}

export interface PeerChatReviewStart {
  success: boolean;
  chatUri?: string;
  turnId?: string;
  reason?: string;
  failureKind?: "pre-dispatch" | "ambiguous-disposed";
}

/**
 * Start a configured review command in a disposable peer chat. When a request
 * ID is supplied, confirm that the pending input still belongs to the session
 * before dispatching the review.
 */
export async function startPeerChatReview(
  hostUrl: string,
  sessionUri: string,
  requestId: string | undefined,
  message: string,
  options?: {
    signal?: AbortSignal;
    plan?: import("./plan-source").PlanEvidence;
    beforeDispatch?: (identity: {
      chatUri: string;
      turnId: string;
      disposablePeerChat: boolean;
      planSourceJson?: string;
      sourceDigest?: string;
    }) => void;
  },
): Promise<PeerChatReviewStart> {
  const signal = options?.signal ?? getOperationSignal();
  assertOperationCurrent("verify", { hostUrl, cardId: sessionUri });
  return withAHPClient(hostUrl, (client) => withSessionState(client, sessionUri, async (initialState, access) => {
    let reviewChatUri: string | undefined;
    let reviewChatCreated = false;

    try {
      throwIfAborted(signal);
      const rootState = await awaitAbortableBoundary(
        () => readRootState(client),
        signal,
      );
      const sessionState = access.getState() ?? initialState;
      access.assertCurrent();
      assertOperationCurrent("verify");
      if (!sessionState) {
        return { success: false, reason: "Session state is unavailable." };
      }
      if (!supportsPeerChats(rootState, sessionState.provider)) {
        return {
          success: false,
          reason: `Agent provider ${sessionState.provider} does not advertise multi-chat support.`,
        };
      }

      const input = requestId
        ? findChatInput(sessionState.inputNeeded, requestId)
        : undefined;
      if (requestId && !input) {
        return { success: false, reason: "The pending plan request is stale." };
      }

      const params = buildCreatePeerChatParams(sessionUri, crypto.randomUUID());
      reviewChatUri = params.chat;
      const turnId = crypto.randomUUID();
      throwIfAborted(signal);
      access.assertCurrent();
      let sourceDigest: string | undefined;
      if (options?.plan) {
        const budget = new EvidenceCaptureBudget(undefined, signal);
        try {
          await verifyPlanEvidence(client, sessionState, options.plan, budget);
          sourceDigest = await readReviewSourceDigest(client, sessionUri, sessionState, budget);
          access.assertCurrent();
          await verifyPlanEvidence(client, access.getState() ?? sessionState, options.plan, budget);
        } finally {
          budget.dispose();
        }
      }
      options?.beforeDispatch?.({
        chatUri: reviewChatUri, turnId, disposablePeerChat: true,
        planSourceJson: options?.plan ? JSON.stringify(options.plan.source) : undefined,
        sourceDigest,
      });
      const created = await runOperationEffect("verify", async () => {
        try {
          await createPeerChatWithCleanupOnFailure(client, params);
          return { success: true as const };
        } catch (error) {
          if (error instanceof PeerChatCleanupRequiredError) throw error;
          // The helper confirms disposal before rethrowing a create failure.
          return { success: false as const, disposition: "retryable" as const, error };
        }
      });
      if (!created.success) throw created.error;
      reviewChatCreated = true;
      throwIfAborted(signal);
      access.assertCurrent();
      assertOperationCurrent("verify");
      if (options?.plan) {
        const budget = new EvidenceCaptureBudget(undefined, signal);
        try {
          await verifyPlanEvidence(client, access.getState() ?? sessionState, options.plan, budget);
        } finally { budget.dispose(); }
      }
      const result = await withChatState(client, params.chat, async (_chat, chat) =>
        runOperationEffect("verify", () => dispatchPeerChatReviewWithClient(
          client, params.chat, turnId, message, signal,
          () => chat.waitFor((state) => state?.activeTurn?.id === turnId
            || state?.turns.some((turn) => turn.id === turnId) === true, 3_000, signal),
        )), signal);
      if (!result.success) return result;
      debug(
        "Started peer-chat review",
        { sessionUri, requestChat: input?.chat, reviewChatUri, turnId },
      );
      return result;
    } catch (error) {
      if (
        error instanceof MessageDispatchAmbiguousError
        || error instanceof PeerChatCleanupRequiredError
      ) {
        throw error;
      }
      if (reviewChatCreated && reviewChatUri) {
        await disposePeerChatAfterFailure(client, reviewChatUri, error, {
          context: "Peer review setup failed",
        });
      }
      throwIfAborted(signal);
      const reason = error instanceof Error ? error.message : String(error);
      console.warn("[ahp:review] Failed to start peer chat:", reason);
      return { success: false, reason, failureKind: "pre-dispatch" };
    }
  }, signal), signal);
}

export async function disposePeerChat(
  hostUrl: string,
  chatUri: string,
): Promise<void> {
  return withAHPClient(hostUrl, async (client) => {
    await client.request("disposeChat", { channel: chatUri });
  });
}

export async function verifyPlanReviewSource(
  hostUrl: string,
  sessionUri: string,
  evidence: PlanEvidence,
  sourceDigest: string | undefined,
  signal?: AbortSignal,
): Promise<void> {
  return withAHPClient(hostUrl, (client) => withSessionState(client, sessionUri, async (state, access) => {
    if (!state) throw new Error("Parent session state is unavailable.");
    const budget = new EvidenceCaptureBudget(undefined, signal);
    try {
      await verifyPlanEvidence(client, state, evidence, budget);
      if (sourceDigest !== undefined
        && await readReviewSourceDigest(client, sessionUri, state, budget) !== sourceDigest) {
        throw new Error("Source bytes changed during the report-only plan review.");
      }
      access.assertCurrent();
      await verifyPlanEvidence(client, access.getState() ?? state, evidence, budget);
    } finally { budget.dispose(); }
  }, signal), signal);
}

/** Find a mirrored chat elicitation in `inputNeeded` by its `ChatInputRequest.id`. */
function findChatInput(
  inputNeeded: SessionState["inputNeeded"],
  requestId: string,
): SessionChatInputRequest | undefined {
  return findChatInputEntry(inputNeeded ?? undefined, requestId) as SessionChatInputRequest | undefined;
}

export async function dispatchInputCompletion(
  client: AhpClient,
  chatUri: string,
  requestId: string,
  response: "accept" | "decline" | "cancel",
  answers?: Record<string, unknown>,
  signal?: AbortSignal,
  beforeDispatch?: () => void,
): Promise<void> {
  signal ??= getOperationSignal();
  assertOperationCurrent("interact");
  let dispatched = false;
  const ambiguousMessage = "The input answer may have been dispatched before confirmation failed.";
  return runOperationEffect("interact", async () => {
    try {
      for (const [questionId, answer] of Object.entries(answers ?? {})) {
        throwIfAborted(signal);
        assertOperationCurrent("interact");
        beforeDispatch?.();
        client.dispatch(chatUri, chatInputAnswerChanged(requestId, questionId, answer));
        dispatched = true;
      }
      assertOperationCurrent("interact");
      beforeDispatch?.();
      await dispatchAndConfirm(
        client, chatUri, chatInputCompleted(requestId, response, answers),
        ambiguousMessage, signal,
      );
    } catch (error) {
      if (dispatched && !(error instanceof MessageDispatchAmbiguousError)) {
        throw new MessageDispatchAmbiguousError(ambiguousMessage, { cause: error });
      }
      throw error;
    }
  });
}

/**
 * Answer a pending *elicitation* (chatInput-kind) request on an AHP session.
 * Dispatches inputAnswerChanged + inputCompleted to the request's owning chat,
 * then **verifies the host actually consumed it** by observing
 * `SessionState.inputNeeded` and confirming the request is gone.
 *
 * `client.ping()` only flushes the transport — it does not confirm the host
 * applied the answer — so a plain dispatch+ping can report a phantom success
 * even when the plan/question was never confirmed. We therefore reduce the
 * retained subscription (bounded) and key success on removal, mirroring the
 * `inputRemoved` check in `app/api/ahp/sessions/input/route.ts`. This is what
 * lets the orchestrator's plan-approval pipeline trust `success` before it logs
 * `plan-approved`.
 *
 * Resolves the target chat and validates staleness from the session-level
 * `SessionState.inputNeeded` aggregate — the authoritative source,
 * since `defaultChat` is documented as only a UI routing hint and may not be
 * the chat the request actually lives on. An unavailable aggregate is unknown,
 * so this function does not dispatch until the host reports the request there.
 *
 * This function only handles `chatInput`-kind entries. Tool-call
 * confirmations (`toolConfirmation` / `toolClientExecution`) are a different
 * wire shape (`chat/toolCallConfirmed` etc., see `actions.ts`) and are not
 * answered here — see `app/api/ahp/sessions/input/route.ts` for that path.
 *
 * `success` is true only when the answer was **applied** (the request left
 * `inputNeeded`). `stale` marks a request that was already gone before we
 * dispatched. A dispatched-but-not-applied answer returns
 * `{ success: false, stale: false }`.
 */
export async function answerInputWithClient(
  client: AhpClient,
  sessionUri: string,
  requestId: string,
  response: "accept" | "decline" | "cancel",
  answers?: Record<string, unknown>,
  options?: {
    verifyTimeoutMs?: number;
    pollIntervalMs?: number;
    signal?: AbortSignal;
    planAnswer?: PlanAnswer;
  },
): Promise<{ success: boolean; stale?: boolean }> {
  const verifyTimeoutMs = options?.verifyTimeoutMs ?? 3_000;
  const signal = options?.signal ?? getOperationSignal();

  throwIfAborted(signal);
  assertOperationCurrent("interact", { cardId: sessionUri });
  return withSessionState(client, sessionUri, async (sessionState, access) => {
    access.assertCurrent();
    assertOperationCurrent("interact");
    const inputNeeded = (access.getState() ?? sessionState)?.inputNeeded;

    if (!hasObservedInputNeeded(inputNeeded)) {
      debug("Input aggregate unavailable; not dispatching:", requestId);
      return { success: false };
    }

    const chatEntry = findChatInput(inputNeeded, requestId);
    if (!chatEntry) {
      debug("Input request not found (stale):", requestId);
      return { success: false, stale: true };
    }

    const planAnswer = options?.planAnswer;
    let receipt: string | null = null;
    const validatePlan = () => {
      access.assertCurrent();
      if (!planAnswer) return;
      const current = resolveAuthoritativeGateRevision(getDb(), sessionUri, "plan", planAnswer.hostUrl);
      if (!current.ok || current.changesetRef !== planAnswer.evidence.changesetRef
        || planAnswer.evidence.source.requestId !== requestId
        || planAnswer.evidence.source.chatUri !== chatEntry.chat) {
        throw new Error("Plan approval evidence changed before dispatch.");
      }
    };
    if (planAnswer) {
      const budget = new EvidenceCaptureBudget(undefined, signal);
      try {
        await verifyPlanEvidence(client, sessionState!, planAnswer.evidence, budget);
        validatePlan();
        assertOperationCurrent("interact");
        receipt = claimPlanAnswer(getDb(), {
          hostUrl: planAnswer.hostUrl, sessionUri, requestId,
          planRef: planAnswer.evidence.changesetRef, action: planAnswer.action,
        });
        if (!receipt) {
          console.warn("[ahp:input] Plan answer already reserved; refusing replay:", requestId);
          return { success: false };
        }
      } finally { budget.dispose(); }
    }

    return runOperationEffect("interact", async () => {
      let recorded = false;
      try {
      await dispatchInputCompletion(
        client, chatEntry.chat, requestId, response, answers, signal,
        validatePlan,
      );
      let applied: boolean;
      try {
        applied = await access.waitFor(
          (state) => isInputObservedRemoved(state?.inputNeeded, requestId),
          verifyTimeoutMs,
        );
      } catch (error) {
        throw new MessageDispatchAmbiguousError(
          "The input answer was dispatched, but its consumption could not be verified.",
          { cause: error },
        );
      }

      if (!applied) {
        if (receipt) {
          completePlanAnswer(getDb(), receipt, false, "Host consumption was not confirmed.");
          recorded = true;
        }
        debug("Answer dispatched but request not consumed (not applied):", requestId, "on", sessionUri);
        return { success: false };
      }

      debug("Answered input", requestId, "on", sessionUri, "(applied)");
      if (receipt) {
        completePlanAnswer(getDb(), receipt, true);
        recorded = true;
      }
      return { success: true };
      } finally {
        if (receipt && !recorded) completePlanAnswer(getDb(), receipt, false, "Plan answer was interrupted.");
      }
    });
  }, signal);
}

export function answerInput(
  hostUrl: string,
  sessionUri: string,
  requestId: string,
  response: "accept" | "decline" | "cancel",
  answers?: Record<string, unknown>,
  options?: {
    verifyTimeoutMs?: number;
    pollIntervalMs?: number;
    signal?: AbortSignal;
    planAnswer?: PlanAnswer;
  },
): Promise<{ success: boolean; stale?: boolean }> {
  const signal = options?.signal ?? getOperationSignal();
  assertOperationCurrent("interact", { hostUrl, cardId: sessionUri });
  return withAHPClient(
    hostUrl,
    (client) =>
      answerInputWithClient(
        client,
        sessionUri,
        requestId,
        response,
        answers,
        { ...options, signal },
      ),
    signal,
  );
}

/**
 * Return review findings on the original plan-review input. VS Code's AHP
 * adapter interprets an accepted select answer with `freeformValues` as an
 * exit-plan-mode revision request.
 */
export function submitPlanFeedback(
  hostUrl: string,
  sessionUri: string,
  requestId: string,
  questionId: string,
  selectedAction: string,
  feedback: string,
  plan?: PlanEvidence,
): Promise<{ success: boolean; stale?: boolean }> {
  const answer = {
    state: "submitted",
    value: buildPlanFeedbackAnswer(selectedAction, feedback),
  };
  return answerInput(hostUrl, sessionUri, requestId, "accept", {
    [questionId]: answer,
  }, plan ? { planAnswer: { hostUrl, evidence: plan, action: "feedback" } } : undefined);
}

/**
 * Fetch the last N turns from a session to read agent output.
 *
 * Turns live on the chat channel, so resolve the session's defaultChat and read
 * its `ChatState.turns` (a tail window of the most recent turns, oldest-first).
 * `fetchTurns` does not return turns directly; it asks the
 * host to page older turns into `ChatState.turns` via `turnsNextCursor`. Since
 * we only need the most recent turns, the subscription snapshot already carries
 * them, so we read them directly and derive `hasMore` from `turnsNextCursor`.
 */
export async function fetchLastTurns(
  hostUrl: string,
  sessionUri: string,
  limit: number = 5
): Promise<{ turns: Turn[]; hasMore: boolean }> {
  return withAHPClient(hostUrl, (client) => withSessionState(client, sessionUri, async (session) => {
    const chatState = session?.defaultChat
      ? await readChatState(client, session.defaultChat)
      : undefined;
    const allTurns = chatState?.turns ?? [];
    const turns = limit > 0 ? allTurns.slice(-limit) : allTurns;
    return { turns, hasMore: Boolean(chatState?.turnsNextCursor) };
  }));
}

/**
 * Fetch a single turn by its exact `Turn.id`, so a caller that knows which
 * turn it cares about (e.g. the turn a specific prompt started) doesn't have
 * to guess by scanning the last few turns in the chat — which can bind to
 * the wrong transcript if other turns happened in between.
 *
 * `Turn.id` is the id the client supplied to `chat/turnStarted` when it
 * started the turn, so this only finds a match when the caller's id was used
 * to start a turn directly (not merely queued — a queued message's id is not
 * guaranteed by the protocol to become the eventual turn id).
 *
 * Only searches the tail window already carried in `ChatState.turns` (no
 * `turnsNextCursor` backfill) — the target turn is expected to still be
 * within that window since callers fetch promptly after injection. Returns
 * `undefined` if the turn isn't present (paged out, or truly never started).
 */
export async function fetchTurnById(
  hostUrl: string,
  sessionUri: string,
  turnId: string,
  searchWindow: number = 20
): Promise<Turn | undefined> {
  const { turns } = await fetchLastTurns(hostUrl, sessionUri, searchWindow);
  return turns.find((t) => t.id === turnId);
}

/** Fetch an exact completed turn from a known chat channel. */
export async function fetchChatTurnById(
  hostUrl: string,
  chatUri: string,
  turnId: string,
): Promise<Turn | undefined> {
  return withAHPClient(hostUrl, async (client) => {
    const chatState = await readChatState(client, chatUri);
    if (chatState?.backgroundWork?.length) return undefined;
    return chatState?.turns.find((turn) => turn.id === turnId);
  });
}

/**
 * Archive (or unarchive) a session via the client-dispatchable
 * `session/isArchivedChanged` action so the change propagates to every AHP client.
 *
 * Copilot CLI sessions are lazily resumed by the host, and actions dispatched
 * while a session is still "unknown" (mid-resume) are silently dropped. To avoid
 * that race we:
 *   1. keep the session subscribed (a single `unsubscribe` at the end) so the host
 *      holds it resident,
 *   2. gate the dispatch on `lifecycle === "ready"`,
 *   3. dispatch, then *verify* by reducing authoritative session actions from the
 *      original subscription (a `ping` only flushes the transport — it does not
 *      confirm the action was applied),
 *   4. re-dispatch once and fail if the bit never appears, so callers can revert.
 */
export async function setSessionArchived(
  hostUrl: string,
  sessionUri: string,
  isArchived: boolean,
  options?: { readyTimeoutMs?: number; verifyTimeoutMs?: number; signal?: AbortSignal }
): Promise<{ success: boolean; status: number; verified: boolean }> {
  const readyTimeoutMs = options?.readyTimeoutMs ?? 15_000;
  const verifyTimeoutMs = options?.verifyTimeoutMs ?? 8_000;
  const targetArchived = isArchived;

  const signal = options?.signal ?? getOperationSignal();
  assertOperationCurrent("interact", { hostUrl, cardId: sessionUri });
  return withAHPClient(hostUrl, (client) => withSessionState(client, sessionUri, async (_initial, access) => {
    const isReady = (state: SessionState | undefined): state is SessionState =>
      state?.lifecycle === "ready" && Number.isInteger(state.status) && state.status >= 0;
    const matchesTarget = (state: SessionState | undefined) =>
      isReady(state) && ((state.status & AHPStatus.IsArchived) !== 0) === targetArchived;
    const result = (verified: boolean) => ({
      success: verified,
      status: access.getState()?.status ?? 0,
      verified,
    });

    if (!await access.waitFor(isReady, readyTimeoutMs)) return result(false);
    if (matchesTarget(access.getState())) return result(true);

    access.assertCurrent();
    return runOperationEffect("interact", async () => {
      await dispatchAndConfirm(
        client, sessionUri, sessionIsArchivedChanged(isArchived),
        "The archive update may have been dispatched before confirmation failed.", signal,
      );
      try {
        if (await access.waitFor(matchesTarget, verifyTimeoutMs / 2)) return result(true);
        // Only explicit human operations retain the legacy retry. An automated
        // unconfirmed mutation keeps its admission slot quarantined instead.
        if (getOperationSignal() || !isReady(access.getState())) return result(false);
        access.assertCurrent();
        assertOperationCurrent("interact");
        await dispatchAndConfirm(
          client, sessionUri, sessionIsArchivedChanged(isArchived),
          "The archive update may have been dispatched before confirmation failed.", signal,
        );
        return result(await access.waitFor(matchesTarget, verifyTimeoutMs / 2));
      } catch (error) {
        if (error instanceof MessageDispatchAmbiguousError) throw error;
        throw new MessageDispatchAmbiguousError(
          "The archive update was dispatched, but its application could not be verified.",
          { cause: error },
        );
      }
    });
  }, signal), signal);
}
