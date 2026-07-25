import "server-only";

import type { SessionChatInputRequest, SessionLifecycle, SessionState, Turn } from "@microsoft/agent-host-protocol";

import { getAHPClient, releaseAHPClient } from "./client-manager";
import { asSessionState, readChatState, readRootState, readSessionState } from "./snapshot";
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

const debug = (...args: unknown[]) => {
  if (process.env.AHP_DEBUG) console.info("[ahp:messenger]", ...args);
};

/**
 * Extract the defaultChat URI and session status from a session subscription.
 */
async function getSessionContext(
  client: Awaited<ReturnType<typeof getAHPClient>>,
  sessionUri: string
): Promise<{ chatUri: string | null; status: number; isInProgress: boolean }> {
  const sessionState = await readSessionState(client, sessionUri);
  const status = sessionState?.status ?? 0;
  const parsed = parseAHPStatus(status);

  const chatUri = sessionState?.defaultChat ?? null;

  return { chatUri, status, isInProgress: parsed.isInProgress };
}

/**
 * Inject a user message into an AHP session.
 *
 * If the session is idle → dispatches chat/turnStarted (starts a new turn).
 * If the session is active → dispatches chat/pendingMessageSet with kind "queued"
 * so the message is delivered after the current turn finishes.
 */
export async function injectMessage(
  hostUrl: string,
  sessionUri: string,
  message: string
): Promise<{ turnId: string; success: boolean; queued?: boolean }> {
  const client = await getAHPClient(hostUrl);

  try {
    const { chatUri, isInProgress } = await getSessionContext(client, sessionUri);

    if (!chatUri) {
      debug("No chat channel found for", sessionUri);
      return { turnId: "", success: false };
    }

    const messageId = crypto.randomUUID();

    if (isInProgress) {
      // Session is active — queue the message for delivery after current turn
      client.dispatch(chatUri, chatQueuedMessage(messageId, message));

      // Verify dispatch reached the server via a ping
      await client.ping();

      debug("Queued message for", sessionUri, "id:", messageId);
      return { turnId: messageId, success: true, queued: true };
    }

    // Session is idle — start a new turn directly
    client.dispatch(chatUri, chatTurnStarted(messageId, message));

    // Verify dispatch reached the server
    await client.ping();

    debug("Injected message into", sessionUri, "turnId:", messageId);
    return { turnId: messageId, success: true };
  } finally {
    releaseAHPClient(hostUrl);
  }
}

export interface PeerChatReviewStart {
  success: boolean;
  chatUri?: string;
  turnId?: string;
  reason?: string;
}

/**
 * Start a configured review command in a peer chat of the session that owns a
 * pending input request. Chats in the session share its workspace,
 * customizations, and plan artifact, so Planwerk does not copy plan content.
 */
export async function startPeerChatReview(
  hostUrl: string,
  sessionUri: string,
  requestId: string,
  message: string,
): Promise<PeerChatReviewStart> {
  const client = await getAHPClient(hostUrl);
  let reviewChatUri: string | undefined;

  try {
    const [sessionState, rootState] = await Promise.all([
      readSessionState(client, sessionUri),
      readRootState(client),
    ]);
    if (!sessionState) {
      return { success: false, reason: "Session state is unavailable." };
    }
    if (!supportsPeerChats(rootState, sessionState.provider)) {
      return {
        success: false,
        reason: `Agent provider ${sessionState.provider} does not advertise multi-chat support.`,
      };
    }

    const input = findChatInput(sessionState.inputNeeded, requestId);
    if (!input) {
      return { success: false, reason: "The pending plan request is stale." };
    }

    const params = buildCreatePeerChatParams(sessionUri, crypto.randomUUID());
    reviewChatUri = params.chat;
    await client.request("createChat", params);

    const turnId = crypto.randomUUID();
    client.dispatch(reviewChatUri, chatTurnStarted(turnId, message));
    await client.ping();
    debug(
      "Started peer-chat review",
      { sessionUri, requestChat: input.chat, reviewChatUri, turnId },
    );
    return { success: true, chatUri: reviewChatUri, turnId };
  } catch (error) {
    if (reviewChatUri) {
      await client.request("disposeChat", { channel: reviewChatUri }).catch(() => {});
    }
    const reason = error instanceof Error ? error.message : String(error);
    console.warn("[ahp:review] Failed to start peer chat:", reason);
    return { success: false, reason };
  } finally {
    releaseAHPClient(hostUrl);
  }
}

export async function disposePeerChat(
  hostUrl: string,
  chatUri: string,
): Promise<void> {
  const client = await getAHPClient(hostUrl);
  try {
    await client.request("disposeChat", { channel: chatUri });
  } finally {
    releaseAHPClient(hostUrl);
  }
}

/** Find a mirrored chat elicitation in `inputNeeded` by its `ChatInputRequest.id`. */
function findChatInput(
  inputNeeded: SessionState["inputNeeded"],
  requestId: string,
): SessionChatInputRequest | undefined {
  return findChatInputEntry(inputNeeded ?? undefined, requestId) as SessionChatInputRequest | undefined;
}

/**
 * Answer a pending *elicitation* (chatInput-kind) request on an AHP session.
 * Dispatches inputAnswerChanged + inputCompleted to the request's owning chat,
 * then **verifies the host actually consumed it** by re-reading
 * `SessionState.inputNeeded` and confirming the request is gone.
 *
 * `client.ping()` only flushes the transport — it does not confirm the host
 * applied the answer — so a plain dispatch+ping can report a phantom success
 * even when the plan/question was never confirmed. We therefore poll the
 * post-dispatch state (bounded) and key success on removal, mirroring the
 * `inputRemoved` check in `app/api/ahp/sessions/input/route.ts`. This is what
 * lets the orchestrator's plan-approval pipeline trust `success` before it logs
 * `plan-approved`.
 *
 * Resolves the target chat and validates staleness from the session-level
 * `SessionState.inputNeeded` aggregate (AHP 0.5+) — the authoritative source,
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
export async function answerInput(
  hostUrl: string,
  sessionUri: string,
  requestId: string,
  response: "accept" | "decline" | "cancel",
  answers?: Record<string, unknown>,
  options?: { verifyTimeoutMs?: number; pollIntervalMs?: number },
): Promise<{ success: boolean; stale?: boolean }> {
  const verifyTimeoutMs = options?.verifyTimeoutMs ?? 3_000;
  const pollMs = options?.pollIntervalMs ?? 400;
  const client = await getAHPClient(hostUrl);

  try {
    const sessionState = await readSessionState(client, sessionUri);
    const inputNeeded = sessionState?.inputNeeded;

    if (!hasObservedInputNeeded(inputNeeded)) {
      debug("Input aggregate unavailable; not dispatching:", requestId);
      return { success: false };
    }

    const chatEntry = findChatInput(inputNeeded, requestId);
    if (!chatEntry) {
      debug("Input request not found (stale):", requestId);
      return { success: false, stale: true };
    }

    const chatUri = chatEntry.chat;

    // Dispatch answers
    if (answers) {
      for (const [questionId, answer] of Object.entries(answers)) {
        client.dispatch(chatUri, chatInputAnswerChanged(requestId, questionId, answer));
      }
    }

    // Dispatch completion
    client.dispatch(chatUri, chatInputCompleted(requestId, response, answers));

    // Flush the dispatch, then verify the host actually consumed the request.
    // `ping` alone only proves the frames reached the server — not that the
    // answer was applied — so poll `inputNeeded` (bounded) for the request to
    // disappear before reporting success.
    await client.ping();

    const isRemoved = (state: SessionState | undefined): boolean =>
      isInputObservedRemoved(state?.inputNeeded, requestId);

    const deadline = Date.now() + verifyTimeoutMs;
    let applied = false;
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, pollMs));
      const after = await readSessionState(client, sessionUri);
      if (isRemoved(after)) {
        applied = true;
        break;
      }
      if (Date.now() >= deadline) break;
    }

    if (!applied) {
      debug("Answer dispatched but request not consumed (not applied):", requestId, "on", sessionUri);
      return { success: false };
    }

    debug("Answered input", requestId, "on", sessionUri, "(applied)");
    return { success: true };
  } finally {
    releaseAHPClient(hostUrl);
  }
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
): Promise<{ success: boolean; stale?: boolean }> {
  const answer = {
    state: "submitted",
    value: buildPlanFeedbackAnswer(selectedAction, feedback),
  };
  return answerInput(hostUrl, sessionUri, requestId, "accept", {
    [questionId]: answer,
  });
}

/**
 * Poll session status until idle or timeout.
 * Resolves when the session's summary.status includes Idle (and not InProgress/InputNeeded).
 */
export async function waitForIdle(
  hostUrl: string,
  sessionUri: string,
  options?: { timeoutMs?: number; pollIntervalMs?: number }
): Promise<{ idle: boolean; timedOut?: boolean }> {
  const timeoutMs = options?.timeoutMs ?? 300_000; // 5 minutes default
  const basePollMs = options?.pollIntervalMs ?? 3_000; // 3s initial poll
  const maxPollMs = 30_000; // cap at 30s
  const deadline = Date.now() + timeoutMs;
  let currentPollMs = basePollMs;

  while (Date.now() < deadline) {
    const client = await getAHPClient(hostUrl);
    try {
      const sessionState = await readSessionState(client, sessionUri);
      const status = sessionState?.status ?? 0;
      const parsed = parseAHPStatus(status);

      if (parsed.isIdle && !parsed.isInProgress && !parsed.isInputNeeded) {
        return { idle: true };
      }

      if (parsed.isError) {
        return { idle: true };
      }
    } finally {
      releaseAHPClient(hostUrl);
    }

    await new Promise((resolve) => setTimeout(resolve, currentPollMs));
    // Exponential backoff: 3s → 4.5s → 6.75s → ... capped at 30s
    currentPollMs = Math.min(currentPollMs * 1.5, maxPollMs);
  }

  debug("waitForIdle timed out for", sessionUri);
  return { idle: false, timedOut: true };
}

/**
 * Fetch the last N turns from a session to read agent output.
 *
 * Turns live on the chat channel, so resolve the session's defaultChat and read
 * its `ChatState.turns` (a tail window of the most recent turns, oldest-first).
 * As of AHP 0.5.x `fetchTurns` no longer returns turns directly; it asks the
 * host to page older turns into `ChatState.turns` via `turnsNextCursor`. Since
 * we only need the most recent turns, the subscription snapshot already carries
 * them, so we read them directly and derive `hasMore` from `turnsNextCursor`.
 */
export async function fetchLastTurns(
  hostUrl: string,
  sessionUri: string,
  limit: number = 5
): Promise<{ turns: Turn[]; hasMore: boolean }> {
  const client = await getAHPClient(hostUrl);
  try {
    const { chatUri } = await getSessionContext(client, sessionUri);
    const chatState = await readChatState(client, chatUri ?? sessionUri);
    const allTurns = chatState?.turns ?? [];
    const turns = limit > 0 ? allTurns.slice(-limit) : allTurns;
    return { turns, hasMore: Boolean(chatState?.turnsNextCursor) };
  } finally {
    releaseAHPClient(hostUrl);
  }
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
  const client = await getAHPClient(hostUrl);
  try {
    const chatState = await readChatState(client, chatUri);
    return chatState?.turns.find((turn) => turn.id === turnId);
  } finally {
    releaseAHPClient(hostUrl);
  }
}

/**
 * Get the current status of a session from its summary.
 */
export async function getSessionStatus(
  hostUrl: string,
  sessionUri: string
): Promise<{
  status: number;
  isIdle: boolean;
  isError: boolean;
  isInProgress: boolean;
  isInputNeeded: boolean;
} | null> {
  const client = await getAHPClient(hostUrl);
  try {
    const sessionState = await readSessionState(client, sessionUri);
    const status = sessionState?.status ?? 0;
    const parsed = parseAHPStatus(status);

    return {
      status,
      ...parsed,
    };
  } finally {
    releaseAHPClient(hostUrl);
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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
 *   3. dispatch, then *verify* by re-reading `summary.status` (a `ping` only flushes
 *      the transport — it does not confirm the action was applied),
 *   4. re-dispatch once and fail if the bit never appears, so callers can revert.
 */
export async function setSessionArchived(
  hostUrl: string,
  sessionUri: string,
  isArchived: boolean,
  options?: { readyTimeoutMs?: number; verifyTimeoutMs?: number; pollIntervalMs?: number }
): Promise<{ success: boolean; status: number; verified: boolean }> {
  const readyTimeoutMs = options?.readyTimeoutMs ?? 15_000;
  const verifyTimeoutMs = options?.verifyTimeoutMs ?? 8_000;
  const pollMs = options?.pollIntervalMs ?? 1_000;
  const targetArchived = isArchived;

  const client = await getAHPClient(hostUrl);

  // Read a fresh server snapshot without dropping the subscription, so the host
  // keeps the session resident across reads/dispatch. `unsubscribe` runs once in
  // the finally block.
  const read = async (): Promise<{ lifecycle: SessionLifecycle | undefined; status: number }> => {
    const { result, subscription } = await client.subscribe(sessionUri);
    void subscription.close();
    const state = asSessionState(result.snapshot);
    return { lifecycle: state?.lifecycle, status: state?.status ?? 0 };
  };

  const matchesTarget = (status: number) =>
    ((status & AHPStatus.IsArchived) !== 0) === targetArchived;

  try {
    // 1. Readiness gate — wait until the host reports the session loaded.
    let snapshot = await read();
    const readyDeadline = Date.now() + readyTimeoutMs;
    while (snapshot.lifecycle !== "ready" && Date.now() < readyDeadline) {
      await sleep(pollMs);
      snapshot = await read();
    }

    // Already in the desired state — nothing to dispatch.
    if (matchesTarget(snapshot.status)) {
      debug("setSessionArchived: already in target state", sessionUri, snapshot.status);
      return { success: true, status: snapshot.status, verified: true };
    }

    // 2. Dispatch the archive/unarchive action on the session channel.
    client.dispatch(sessionUri, sessionIsArchivedChanged(isArchived));
    await client.ping();

    // 3. Verify the summary actually reflects the change (with one re-dispatch).
    const verifyDeadline = Date.now() + verifyTimeoutMs;
    let redispatched = false;
    let lastStatus = snapshot.status;
    while (Date.now() < verifyDeadline) {
      await sleep(pollMs);
      const { status } = await read();
      lastStatus = status;
      if (matchesTarget(status)) {
        debug("setSessionArchived: verified", sessionUri, status);
        return { success: true, status, verified: true };
      }
      if (!redispatched && Date.now() > verifyDeadline - verifyTimeoutMs / 2) {
        debug("setSessionArchived: re-dispatching", sessionUri);
        client.dispatch(sessionUri, sessionIsArchivedChanged(isArchived));
        await client.ping();
        redispatched = true;
      }
    }

    debug("setSessionArchived: unverified after timeout", sessionUri, lastStatus);
    return { success: false, status: lastStatus, verified: false };
  } finally {
    await client.unsubscribe(sessionUri).catch(() => {});
    releaseAHPClient(hostUrl);
  }
}
