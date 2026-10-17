import { NextRequest, NextResponse } from "next/server";

import { ahpErrorResponse } from "@/lib/ahp/api-error";
import { refreshSessionEvidence } from "@/lib/ahp/session-evidence";
import { validateLocalMutationRequest } from "@/lib/http/local-mutation";

export async function POST(request: NextRequest) {
  const requestError = validateLocalMutationRequest(request);
  if (requestError) return NextResponse.json({ error: requestError }, { status: 403 });

  let body: { hostUrl?: unknown; sessionUri?: unknown } | null;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "A JSON object is required" }, { status: 400 });
  }
  const hostUrl = typeof body?.hostUrl === "string" ? body.hostUrl.trim() : "";
  const sessionUri = typeof body?.sessionUri === "string" ? body.sessionUri.trim() : "";
  if (!hostUrl || !sessionUri) {
    return NextResponse.json({ error: "hostUrl and sessionUri are required" }, { status: 400 });
  }
  try {
    const result = await refreshSessionEvidence(hostUrl, sessionUri, request.signal);
    const status = result.success ? 200
      : result.reason === "unsupported" ? 422
        : result.detail === "deadline" ? 503 : 409;
    return NextResponse.json(result, { status });
  } catch (error) {
    return ahpErrorResponse(error, "Failed to refresh session evidence");
  }
}
