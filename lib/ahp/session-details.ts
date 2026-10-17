import "server-only";

import type { AhpClient } from "@microsoft/agent-host-protocol/client";
import type { SessionState } from "@microsoft/agent-host-protocol";

import type { SessionDetails } from "../types";
import { chatTurnResume } from "./actions";
import { withAHPClient } from "./client-operation";
import { dispatchAndConfirm, MessageDispatchAmbiguousError } from "./dispatch-confirmation";
import {
  matchesResumableTurn,
  projectSessionDetails,
} from "./session-details-core";
import { readChatState, withChatState, withSessionState } from "./snapshot";

export async function readSessionDetailsForState(
  client: AhpClient,
  sessionState: SessionState,
  signal?: AbortSignal,
): Promise<SessionDetails> {
  const chatState = sessionState.defaultChat
    ? await readChatState(client, sessionState.defaultChat, signal)
    : undefined;
  return projectSessionDetails(sessionState, chatState);
}

export async function fetchSessionDetails(
  hostUrl: string,
  sessionUri: string,
  signal?: AbortSignal,
): Promise<SessionDetails> {
  return withAHPClient(hostUrl, (client) => withSessionState(client, sessionUri, async (sessionState) => {
    if (!sessionState) {
      throw new Error("The agent host did not return session details");
    }
    return readSessionDetailsForState(client, sessionState, signal);
  }, signal), signal);
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
  return withAHPClient(hostUrl, (client) => withSessionState(client, sessionUri, async (sessionState, session) => {
    if (!sessionState) {
      throw new Error("The agent host did not return session details");
    }
    if (!sessionState.defaultChat || sessionState.defaultChat !== expectedChatUri) {
      return {
        success: false,
        reason: "stale",
        details: await readSessionDetailsForState(client, sessionState, signal),
      };
    }
    return withChatState(client, expectedChatUri, async (chatState, chat) => {
      const details = () => projectSessionDetails(session.getState() ?? sessionState, chat.getState());
      const before = projectSessionDetails(sessionState, chatState);
      if (
        session.getState()?.defaultChat !== expectedChatUri
        || !matchesResumableTurn(before, expectedChatUri, expectedTurnId)
      ) {
        return { success: false, reason: "stale", details: before };
      }

      await dispatchAndConfirm(
        client,
        expectedChatUri,
        chatTurnResume(expectedTurnId),
        "The turn resume may have been dispatched before the transport failed.",
        signal,
      );

      try {
        const applied = await chat.waitFor(
          () => !matchesResumableTurn(details(), expectedChatUri, expectedTurnId),
          5_000,
        );
        const latest = details();
        if (applied) {
          return { success: true, details: latest };
        }
        return { success: false, reason: "not-applied", details: latest };
      } catch (error) {
        throw new MessageDispatchAmbiguousError(
          "The turn resume was dispatched, but its application could not be verified.",
          { cause: error, chatUri: expectedChatUri, turnId: expectedTurnId },
        );
      }
    }, signal);
  }, signal), signal);
}
