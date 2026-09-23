import { NextRequest, NextResponse } from "next/server";

import { ahpErrorResponse } from "@/lib/ahp/api-error";
import { resumeErroredTurn } from "@/lib/ahp/session-details";
import { validateLocalMutationRequest } from "@/lib/http/local-mutation";

export async function POST(request: NextRequest) {
  const requestError = validateLocalMutationRequest(request);
  if (requestError) {
    return NextResponse.json({ error: requestError }, { status: 403 });
  }

  const body = (await request.json()) as {
    hostUrl?: unknown;
    sessionUri?: unknown;
    chatUri?: unknown;
    turnId?: unknown;
  };
  const hostUrl = typeof body.hostUrl === "string" ? body.hostUrl : "";
  const sessionUri = typeof body.sessionUri === "string" ? body.sessionUri : "";
  const chatUri = typeof body.chatUri === "string" ? body.chatUri : "";
  const turnId = typeof body.turnId === "string" ? body.turnId : "";
  if (!hostUrl || !sessionUri || !chatUri || !turnId) {
    return NextResponse.json(
      { error: "hostUrl, sessionUri, chatUri, and turnId are required" },
      { status: 400 },
    );
  }

  try {
    const result = await resumeErroredTurn(
      hostUrl,
      sessionUri,
      chatUri,
      turnId,
      request.signal,
    );
    if (!result.success) {
      return NextResponse.json(
        {
          error: result.reason === "stale"
            ? "The resumable error is no longer current"
            : "The agent host did not apply the resume request",
          stale: result.reason === "stale",
          details: result.details,
        },
        { status: 409 },
      );
    }
    return NextResponse.json({ ok: true, details: result.details });
  } catch (error) {
    console.error(
      "[ahp:resume] error:",
      error instanceof Error ? error.message : error,
    );
    return ahpErrorResponse(error, "Failed to resume errored turn");
  }
}
