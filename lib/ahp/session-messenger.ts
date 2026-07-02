import "server-only";

import type { SessionState, ChatState, SessionLifecycle } from "@microsoft/agent-host-protocol";

import { getAHPClient, releaseAHPClient } from "./client-manager";
import { AHPStatus, parseAHPStatus } from "./types";
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
  const { result, subscription } = await client.subscribe(sessionUri);
  void subscription.close();
  await client.unsubscribe(sessionUri).catch(() => {});

  const sessionState = result.snapshot?.state as SessionState | undefined;
  const status = sessionState?.summary?.status ?? 0;
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

/**
 * Answer a pending input request on an AHP session.
 * Dispatches inputAnswerChanged + inputCompleted.
 */
export async function answerInput(
  hostUrl: string,
  sessionUri: string,
  requestId: string,
  response: "accept" | "decline" | "cancel",
  answers?: Record<string, unknown>
): Promise<{ success: boolean; stale?: boolean }> {
  const client = await getAHPClient(hostUrl);

  try {
    const { chatUri } = await getSessionContext(client, sessionUri);

    if (!chatUri) {
      debug("No chat channel found for", sessionUri);
      return { success: false };
    }

    // Verify input request still exists
    const { result: chatResult, subscription: chatSub } =
      await client.subscribe(chatUri);
    void chatSub.close();
    await client.unsubscribe(chatUri).catch(() => {});

    const chatState = chatResult.snapshot?.state as ChatState | undefined;
    const chatInputRequests = chatState?.inputRequests;

    if (!chatInputRequests?.some((r) => r.id === requestId)) {
      debug("Input request not found (stale):", requestId);
      return { success: false, stale: true };
    }

    // Dispatch answers
    if (answers) {
      for (const [questionId, answer] of Object.entries(answers)) {
        client.dispatch(chatUri, chatInputAnswerChanged(requestId, questionId, answer));
      }
    }

    // Dispatch completion
    client.dispatch(chatUri, chatInputCompleted(requestId, response, answers));

    // Verify dispatch reached the server
    await client.ping();

    debug("Answered input", requestId, "on", sessionUri);
    return { success: true };
  } finally {
    releaseAHPClient(hostUrl);
  }
}

/**
 * Force a plan revision ("rubber duck") on a session that is blocked on a
 * copilotcli plan-approval input.
 *
 * The plan-approval input offers approve/execute options. Declining it makes
 * the agent surface a follow-up text input — "What changes would you like me
 * to make to the plan?" — which we answer with the rubber-duck critique. The
 * agent then revises its plan and presents a new plan-approval input.
 *
 * Both steps run on one connection so the dispatches are flushed in order.
 */
export async function requestPlanChanges(
  hostUrl: string,
  sessionUri: string,
  planRequestId: string,
  feedback: string,
  options?: { timeoutMs?: number; pollIntervalMs?: number },
): Promise<{ success: boolean; stale?: boolean }> {
  // Allow generous time for the agent to surface the follow-up text input —
  // declining the plan is irreversible, so we must answer the "what changes?"
  // input that follows. If it never appears in time the heartbeat's stuck-card
  // nudging is the backstop.
  const timeoutMs = options?.timeoutMs ?? 60_000;
  const pollMs = options?.pollIntervalMs ?? 500;
  const client = await getAHPClient(hostUrl);

  try {
    const { chatUri } = await getSessionContext(client, sessionUri);
    if (!chatUri) {
      debug("No chat channel found for", sessionUri);
      return { success: false };
    }

    const readInputs = async (): Promise<ChatState["inputRequests"]> => {
      const { result, subscription } = await client.subscribe(chatUri);
      void subscription.close();
      await client.unsubscribe(chatUri).catch(() => {});
      return (result.snapshot?.state as ChatState | undefined)?.inputRequests;
    };

    // The plan-approval input must still be present.
    const current = await readInputs();
    if (!current?.some((r) => r.id === planRequestId)) {
      debug("Plan-approval request not found (stale):", planRequestId);
      return { success: false, stale: true };
    }

    // Step 1 — decline the plan-approval; the agent will ask what to change.
    client.dispatch(chatUri, chatInputCompleted(planRequestId, "decline"));
    await client.ping();

    // Step 2 — wait for the follow-up text input and answer it with feedback.
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, pollMs));
      const inputs = await readInputs();
      const followUp = inputs?.find(
        (r) => r.id !== planRequestId && r.questions?.[0]?.kind === "text",
      );
      if (!followUp) continue;

      const questionId = followUp.questions![0].id;
      const answer = { state: "submitted", value: { kind: "text", value: feedback } };
      client.dispatch(chatUri, chatInputAnswerChanged(followUp.id, questionId, answer));
      client.dispatch(chatUri, chatInputCompleted(followUp.id, "accept", { [questionId]: answer }));
      await client.ping();
      debug("Requested plan changes on", sessionUri, "follow-up:", followUp.id);
      return { success: true };
    }

    debug("Plan-change follow-up input never appeared for", sessionUri);
    return { success: false };
  } finally {
    releaseAHPClient(hostUrl);
  }
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
      const { result, subscription } = await client.subscribe(sessionUri);
      void subscription.close();
      await client.unsubscribe(sessionUri).catch(() => {});

      const sessionState = result.snapshot?.state as SessionState | undefined;
      const status = sessionState?.summary?.status ?? 0;
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
 * In AHP 0.4.0 turns live on the chat channel, so resolve the session's
 * defaultChat and fetch from there, falling back to the session URI.
 */
export async function fetchLastTurns(
  hostUrl: string,
  sessionUri: string,
  limit: number = 5
): Promise<{ turns: unknown[]; hasMore: boolean }> {
  const client = await getAHPClient(hostUrl);
  try {
    const { chatUri } = await getSessionContext(client, sessionUri);
    const result = await client.request("fetchTurns", {
      channel: chatUri ?? sessionUri,
      limit,
    });
    return { turns: result.turns, hasMore: result.hasMore };
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
    const { result, subscription } = await client.subscribe(sessionUri);
    void subscription.close();
    await client.unsubscribe(sessionUri).catch(() => {});

    const sessionState = result.snapshot?.state as SessionState | undefined;
    const status = sessionState?.summary?.status ?? 0;
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
    const state = result.snapshot?.state as SessionState | undefined;
    return { lifecycle: state?.lifecycle, status: state?.summary?.status ?? 0 };
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
