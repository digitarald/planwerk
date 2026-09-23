import "server-only";

import type { AhpClient } from "@microsoft/agent-host-protocol/client";
import type { SessionState } from "@microsoft/agent-host-protocol";

import { throwIfAborted } from "../abort";
import type { SessionDetails } from "../types";
import { chatTurnResume } from "./actions";
import { withAHPClient } from "./client-operation";
import { dispatchAndConfirm } from "./dispatch-confirmation";
import {
  matchesResumableTurn,
  projectSessionDetails,
} from "./session-details-core";
import { readChatState, readSessionState } from "./snapshot";

export async function readSessionDetailsForState(
  client: AhpClient,
  sessionState: SessionState,
): Promise<SessionDetails> {
  const chatState = sessionState.defaultChat
    ? await readChatState(client, sessionState.defaultChat)
    : undefined;
  return projectSessionDetails(sessionState, chatState);
}

export async function fetchSessionDetails(
  hostUrl: string,
  sessionUri: string,
  signal?: AbortSignal,
): Promise<SessionDetails> {
  return withAHPClient(hostUrl, async (client) => {
    const sessionState = await readSessionState(client, sessionUri);
    if (!sessionState) {
      throw new Error("The agent host did not return session details");
    }
    return readSessionDetailsForState(client, sessionState);
  }, signal);
}

export type ResumeErroredTurnResult =
  | { success: true; details: SessionDetails }
  | { success: false; reason: "stale" | "not-applied"; details: SessionDetails };

export async function resumeErroredTurn(
  hostUrl: string,
  sessionUri: string,
  expectedChatUri: string,
  expectedTurnId: string,
  signal?: AbortSignal,
): Promise<ResumeErroredTurnResult> {
  return withAHPClient(hostUrl, async (client) => {
    const sessionState = await readSessionState(client, sessionUri);
    if (!sessionState) {
      throw new Error("The agent host did not return session details");
    }
    const before = await readSessionDetailsForState(client, sessionState);
    if (!matchesResumableTurn(before, expectedChatUri, expectedTurnId)) {
      return { success: false, reason: "stale", details: before };
    }

    await dispatchAndConfirm(
      client,
      expectedChatUri,
      chatTurnResume(expectedTurnId),
      "The turn resume may have been dispatched before the transport failed.",
      signal,
    );

    const deadline = Date.now() + 5_000;
    let latest = before;
    while (Date.now() < deadline) {
      throwIfAborted(signal);
      await new Promise((resolve) => setTimeout(resolve, 250));
      const currentSession = await readSessionState(client, sessionUri);
      if (!currentSession) continue;
      latest = await readSessionDetailsForState(client, currentSession);
      if (!matchesResumableTurn(latest, expectedChatUri, expectedTurnId)) {
        return { success: true, details: latest };
      }
    }

    return { success: false, reason: "not-applied", details: latest };
  }, signal);
}
