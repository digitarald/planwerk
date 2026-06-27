import { NextRequest, NextResponse } from "next/server";

import { injectMessage } from "@/lib/ahp/session-messenger";

const debug = (...args: unknown[]) => {
  if (process.env.AHP_DEBUG) console.info("[ahp:message]", ...args);
};

export async function POST(request: NextRequest) {
  const body = (await request.json()) as {
    hostUrl?: string;
    sessionUri?: string;
    message?: string;
  };

  const { hostUrl, sessionUri, message } = body;

  if (!hostUrl || !sessionUri || !message?.trim()) {
    return NextResponse.json(
      { error: "hostUrl, sessionUri, and message are required" },
      { status: 400 }
    );
  }

  debug("POST:", sessionUri, "len:", message.trim().length);

  try {
    const result = await injectMessage(hostUrl, sessionUri, message.trim());

    if (!result.success) {
      return NextResponse.json(
        { error: "Failed to deliver message to session" },
        { status: 502 }
      );
    }

    return NextResponse.json({
      ok: true,
      turnId: result.turnId,
      queued: result.queued ?? false,
    });
  } catch (err) {
    console.error("[ahp:message] error:", err instanceof Error ? err.message : err);
    const errMessage = err instanceof Error ? err.message : "Failed to send message";
    return NextResponse.json({ error: errMessage }, { status: 502 });
  }
}
