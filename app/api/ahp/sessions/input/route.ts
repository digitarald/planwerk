import { NextRequest, NextResponse } from "next/server";
import type {
  SessionState,
  SessionChatInputRequest,
  SessionToolConfirmationRequest,
} from "@microsoft/agent-host-protocol";

import {
  chatInputAnswerChanged,
  chatInputCompleted,
  chatToolCallConfirmed,
  chatToolCallResultConfirmed,
} from "@/lib/ahp/actions";
import { readSessionState } from "@/lib/ahp/snapshot";
import { ahpErrorResponse } from "@/lib/ahp/api-error";

const debug = (...args: unknown[]) => {
  if (process.env.AHP_DEBUG) console.info("[ahp:input]", ...args);
};

type InputEntry = NonNullable<SessionState["inputNeeded"]>[number];

/** Find an `inputNeeded` entry by its opaque host key (used for tool confirmations). */
function findEntryById(inputNeeded: SessionState["inputNeeded"], requestId: string): InputEntry | undefined {
  return inputNeeded?.find((e) => e.id === requestId);
}

/** Find a mirrored chat elicitation by its underlying `ChatInputRequest.id`. */
function findChatInput(inputNeeded: SessionState["inputNeeded"], requestId: string): SessionChatInputRequest | undefined {
  const entry = inputNeeded?.find(
    (e) => (e.kind as string) === "chatInput" && (e as SessionChatInputRequest).request.id === requestId,
  );
  return entry as SessionChatInputRequest | undefined;
}

/**
 * Answer an outstanding session input from Planwerk. Everything is resolved from the
 * session-level `SessionState.inputNeeded` aggregate (AHP 0.5) so the owning chat and
 * tool-call identifiers are server-derived rather than trusted from the client.
 *
 * - `approved` present → tool-call confirmation (dispatch `chat/toolCallConfirmed` or
 *   `chat/toolCallResultConfirmed`).
 * - otherwise → user elicitation (dispatch `chat/inputAnswerChanged` + `chat/inputCompleted`).
 */
export async function POST(request: NextRequest) {
  const body = (await request.json()) as {
    hostUrl?: string;
    sessionUri?: string;
    requestId?: string;
    response?: "accept" | "decline" | "cancel";
    answers?: Record<string, unknown>;
    approved?: boolean;
    optionId?: string;
  };

  const { hostUrl, sessionUri, requestId } = body;

  if (!hostUrl || !sessionUri || !requestId) {
    return NextResponse.json(
      { error: "hostUrl, sessionUri, and requestId are required" },
      { status: 400 },
    );
  }

  const isToolConfirmation = typeof body.approved === "boolean";
  debug("POST:", sessionUri, "requestId:", requestId, isToolConfirmation ? `approved:${body.approved}` : `response:${body.response}`);

  if (!isToolConfirmation && !body.response) {
    return NextResponse.json({ error: "response is required for elicitations" }, { status: 400 });
  }

  try {
    const { getAHPClient, releaseAHPClient } = await import("@/lib/ahp/client-manager");
    const client = await getAHPClient(hostUrl);

    try {
      const sessionState = await readSessionState(client, sessionUri);
      const inputNeeded = sessionState?.inputNeeded;

      // ── Tool-call confirmation ──────────────────────────────────────────────
      if (isToolConfirmation) {
        const entry = findEntryById(inputNeeded, requestId);
        if (!entry || (entry.kind as string) !== "toolConfirmation") {
          debug("tool confirmation not found — stale");
          return NextResponse.json({ error: "Tool confirmation not found", stale: true }, { status: 409 });
        }

        const tc = entry as SessionToolConfirmationRequest;
        const isResult = (tc.toolCall.status as string) === "pending-result-confirmation";
        const action = isResult
          ? chatToolCallResultConfirmed({
              turnId: tc.turnId,
              toolCallId: tc.toolCall.toolCallId,
              approved: body.approved!,
            })
          : chatToolCallConfirmed({
              turnId: tc.turnId,
              toolCallId: tc.toolCall.toolCallId,
              approved: body.approved!,
              selectedOptionId: body.optionId,
            });

        client.dispatch(tc.chat, action);
        await new Promise((resolve) => setTimeout(resolve, 300));

        const after = await readSessionState(client, sessionUri);
        const inputRemoved = !findEntryById(after?.inputNeeded, requestId);
        debug("tool confirmation inputRemoved:", inputRemoved);
        return NextResponse.json({ ok: true, inputRemoved });
      }

      // ── User elicitation ────────────────────────────────────────────────────
      // Prefer the owning chat from the aggregate; fall back to defaultChat for
      // hosts that don't mirror the elicitation into `inputNeeded`.
      const chatEntry = findChatInput(inputNeeded, requestId);
      const chatUri = chatEntry?.chat ?? sessionState?.defaultChat;

      if (!chatUri) {
        return NextResponse.json({ error: "No chat channel found" }, { status: 400 });
      }

      // If the aggregate is populated but this request isn't in it, it's stale.
      if (inputNeeded && inputNeeded.length > 0 && !chatEntry && !findEntryById(inputNeeded, requestId)) {
        debug("elicitation not found in inputNeeded — stale");
        return NextResponse.json({ error: "Input request not found", stale: true }, { status: 409 });
      }

      if (body.answers) {
        for (const [questionId, answer] of Object.entries(body.answers)) {
          client.dispatch(chatUri, chatInputAnswerChanged(requestId, questionId, answer));
        }
      }
      client.dispatch(chatUri, chatInputCompleted(requestId, body.response!, body.answers));

      await new Promise((resolve) => setTimeout(resolve, 300));

      const after = await readSessionState(client, sessionUri);
      const inputRemoved =
        !findChatInput(after?.inputNeeded, requestId) && !findEntryById(after?.inputNeeded, requestId);
      debug("elicitation inputRemoved:", inputRemoved);
      return NextResponse.json({ ok: true, inputRemoved });
    } finally {
      releaseAHPClient(hostUrl);
    }
  } catch (err) {
    console.error("[ahp:input] error:", err instanceof Error ? err.message : err);
    return ahpErrorResponse(err, "Failed to submit input");
  }
}
