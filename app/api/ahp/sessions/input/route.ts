import { NextRequest, NextResponse } from "next/server";
import type { StateAction } from "@microsoft/agent-host-protocol";

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

  try {
    const { getAHPClient, releaseAHPClient } = await import("@/lib/ahp/client-manager");
    const client = await getAHPClient(hostUrl);

    try {
      // Cast the action since const enum values match the string literals
      const action = {
        type: "session/inputCompleted",
        requestId,
        response,
        ...(body.answers ? { answers: body.answers } : {}),
      } as unknown as StateAction;

      client.dispatch(sessionUri, action);
    } finally {
      releaseAHPClient(hostUrl);
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to submit input";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
