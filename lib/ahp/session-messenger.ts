import "server-only";

import type { SessionState, ChatState } from "@microsoft/agent-host-protocol";

import { getAHPClient, releaseAHPClient } from "./client-manager";
import { parseAHPStatus } from "./types";
import {
  chatTurnStarted,
  chatQueuedMessage,
  chatInputAnswerChanged,
  chatInputCompleted,
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
