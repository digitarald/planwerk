import { NextRequest, NextResponse } from "next/server";
import type { SessionState, ChatState } from "@microsoft/agent-host-protocol";

import { chatInputAnswerChanged, chatInputCompleted } from "@/lib/ahp/actions";

const debug = (...args: unknown[]) => {
  if (process.env.AHP_DEBUG) console.info("[ahp:input]", ...args);
};

export async function POST(request: NextRequest) {
  const body = (await request.json()) as {
    hostUrl?: string;
    sessionUri?: string;
    requestId?: string;
    response?: "accept" | "decline" | "cancel";
    answers?: Record<string, unknown>;
  };

  const { hostUrl, sessionUri, requestId, response } = body;

  if (!hostUrl || !sessionUri || !requestId || !response) {
    return NextResponse.json(
      { error: "hostUrl, sessionUri, requestId, and response are required" },
      { status: 400 }
    );
  }

  debug("POST:", sessionUri, "requestId:", requestId, "response:", response);

  try {
    const { getAHPClient, releaseAHPClient } = await import("@/lib/ahp/client-manager");
    const client = await getAHPClient(hostUrl);

    try {
      // Subscribe to session to discover chat channel
      const { result: sessionResult, subscription: sessionSub } = await client.subscribe(sessionUri);
      void sessionSub.close();

      const sessionState = sessionResult.snapshot?.state as SessionState | undefined;
      const defaultChatUri = sessionState?.defaultChat;

      debug("chatUri:", defaultChatUri ? "found" : "none");

      if (!defaultChatUri) {
        await client.unsubscribe(sessionUri).catch(() => {});
        return NextResponse.json({ error: "No chat channel found" }, { status: 400 });
      }

      // Subscribe to chat channel and verify inputRequest exists
      const { result: chatResult, subscription: chatSub } = await client.subscribe(defaultChatUri);
      void chatSub.close();

      const chatState = chatResult.snapshot?.state as ChatState | undefined;
      const chatInputRequests = chatState?.inputRequests;

      if (!chatInputRequests?.some(r => r.id === requestId)) {
        debug("inputRequest not found — already consumed or stale");
        await client.unsubscribe(defaultChatUri).catch(() => {});
        await client.unsubscribe(sessionUri).catch(() => {});
        return NextResponse.json({ error: "Input request not found", stale: true }, { status: 409 });
      }

      // Dispatch inputAnswerChanged for each answer
      if (body.answers) {
        for (const [questionId, answer] of Object.entries(body.answers)) {
          client.dispatch(defaultChatUri, chatInputAnswerChanged(requestId, questionId, answer));
        }
      }

      // Dispatch inputCompleted
      client.dispatch(defaultChatUri, chatInputCompleted(requestId, response, body.answers));

      // Brief wait for state to propagate, then verify
      await new Promise(resolve => setTimeout(resolve, 300));

      // Re-read chat state to check if inputRequest was removed
      const { result: verifyResult, subscription: verifySub } = await client.subscribe(defaultChatUri);
      void verifySub.close();
      const verifyState = verifyResult.snapshot?.state as ChatState | undefined;
      const remaining = verifyState?.inputRequests;
      const inputRemoved = !remaining?.some(r => r.id === requestId);

      debug("inputRemoved:", inputRemoved);

      // Cleanup
      await client.unsubscribe(defaultChatUri).catch(() => {});
      await client.unsubscribe(sessionUri).catch(() => {});

      return NextResponse.json({
        ok: true,
        inputRemoved,
      });
    } finally {
      releaseAHPClient(hostUrl);
    }
  } catch (err) {
    console.error("[ahp:input] error:", err instanceof Error ? err.message : err);
    const message = err instanceof Error ? err.message : "Failed to submit input";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
