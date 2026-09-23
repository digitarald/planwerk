import { NextRequest, NextResponse } from "next/server";

import { ahpErrorResponse } from "@/lib/ahp/api-error";
import { fetchSessionDetails } from "@/lib/ahp/session-details";
import { validateLocalMutationRequest } from "@/lib/http/local-mutation";

export async function POST(request: NextRequest) {
  const requestError = validateLocalMutationRequest(request);
  if (requestError) {
    return NextResponse.json({ error: requestError }, { status: 403 });
  }

  const body = (await request.json()) as {
    hostUrl?: unknown;
    sessionUri?: unknown;
  };
  const hostUrl = typeof body.hostUrl === "string" ? body.hostUrl : "";
  const sessionUri = typeof body.sessionUri === "string" ? body.sessionUri : "";
  if (!hostUrl || !sessionUri) {
    return NextResponse.json(
      { error: "hostUrl and sessionUri are required" },
      { status: 400 },
    );
  }

  try {
    const details = await fetchSessionDetails(
      hostUrl,
      sessionUri,
      request.signal,
    );
    return NextResponse.json({ details });
  } catch (error) {
    console.error(
      "[ahp:details] error:",
      error instanceof Error ? error.message : error,
    );
    return ahpErrorResponse(error, "Failed to read session details");
  }
}
