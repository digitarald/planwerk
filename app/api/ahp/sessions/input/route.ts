import { NextRequest, NextResponse } from "next/server";
import type {
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
import {
  findChatInputEntry,
  findEntryById,
  hasObservedInputNeeded,
  isInputObservedRemoved,
} from "@/lib/ahp/input-presence";
import { resolveToolConfirmationDecision } from "@/lib/ahp/tool-safety";
import { withAHPClient } from "@/lib/ahp/client-operation";
import { validateLocalMutationRequest } from "@/lib/http/local-mutation";

const debug = (...args: unknown[]) => {
  if (process.env.AHP_DEBUG) console.info("[ahp:input]", ...args);
};

/**
 * Answer an outstanding session input from Planwerk. Everything is resolved from the
 * session-level `SessionState.inputNeeded` aggregate so the owning chat and
 * tool-call identifiers are server-derived rather than trusted from the client.
 *
 * - `approved` present → tool-call confirmation (dispatch `chat/toolCallConfirmed` or
 *   `chat/toolCallResultConfirmed`).
 * - otherwise → user elicitation (dispatch `chat/inputAnswerChanged` + `chat/inputCompleted`).
 */
export async function POST(request: NextRequest) {
  const requestError = validateLocalMutationRequest(request);
  if (requestError) {
    return NextResponse.json({ error: requestError }, { status: 403 });
  }

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
    return await withAHPClient(hostUrl, async (client) => {
      const sessionState = await readSessionState(client, sessionUri);
      const inputNeeded = sessionState?.inputNeeded;
      if (!hasObservedInputNeeded(inputNeeded)) {
        return NextResponse.json(
          { error: "Input state is not yet available; retry shortly" },
          { status: 503 },
        );
      }

      // Authentication input is resolved only by the active client
      // completing OAuth through `authenticate`. Never forward credentials,
      // resource URLs, or an implicit chat response from Planwerk.
      const matchingEntry = findEntryById(inputNeeded, requestId);
      if ((matchingEntry?.kind as unknown) === "toolAuthentication") {
        return NextResponse.json(
          { error: "Tool authentication must be completed in VS Code" },
          { status: 403 },
        );
      }

      // ── Tool-call confirmation ──────────────────────────────────────────────
      if (isToolConfirmation) {
        const entry = matchingEntry;
        if (!entry || (entry.kind as string) !== "toolConfirmation") {
          debug("tool confirmation not found — stale");
          return NextResponse.json({ error: "Tool confirmation not found", stale: true }, { status: 409 });
        }

        const tc = entry as SessionToolConfirmationRequest;
        const decision = resolveToolConfirmationDecision(
          tc.toolCall,
          body.approved!,
          body.optionId,
        );
        if (!decision.ok) {
          return NextResponse.json({ error: decision.error }, { status: 400 });
        }
        const isResult = (tc.toolCall.status as string) === "pending-result-confirmation";
        const action = isResult
          ? chatToolCallResultConfirmed({
              turnId: tc.turnId,
              toolCallId: tc.toolCall.toolCallId,
              approved: decision.approved,
            })
          : chatToolCallConfirmed({
              turnId: tc.turnId,
              toolCallId: tc.toolCall.toolCallId,
              approved: decision.approved,
              selectedOptionId: decision.selectedOptionId,
            });

        client.dispatch(tc.chat, action);
        await new Promise((resolve) => setTimeout(resolve, 300));

        const after = await readSessionState(client, sessionUri);
        const inputRemoved = isInputObservedRemoved(after?.inputNeeded, requestId);
        debug("tool confirmation inputRemoved:", inputRemoved);
        return NextResponse.json({ ok: true, inputRemoved });
      }

      // ── User elicitation ────────────────────────────────────────────────────
      // The aggregate is the sole runtime authority and carries the owning chat.
      // Do not route through defaultChat: it may belong to a different request.
      const chatEntry = findChatInputEntry(inputNeeded, requestId) as SessionChatInputRequest | undefined;
      if (!chatEntry) {
        debug("elicitation not found in inputNeeded — stale");
        return NextResponse.json({ error: "Input request not found", stale: true }, { status: 409 });
      }
      const chatUri = chatEntry.chat;

      if (body.answers) {
        for (const [questionId, answer] of Object.entries(body.answers)) {
          client.dispatch(chatUri, chatInputAnswerChanged(requestId, questionId, answer));
        }
      }
      client.dispatch(chatUri, chatInputCompleted(requestId, body.response!, body.answers));

      await new Promise((resolve) => setTimeout(resolve, 300));

      const after = await readSessionState(client, sessionUri);
      const inputRemoved = isInputObservedRemoved(after?.inputNeeded, requestId);
      debug("elicitation inputRemoved:", inputRemoved);
      return NextResponse.json({ ok: true, inputRemoved });
    });
  } catch (err) {
    console.error("[ahp:input] error:", err instanceof Error ? err.message : err);
    return ahpErrorResponse(err, "Failed to submit input");
  }
}
