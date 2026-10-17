import { NextRequest, NextResponse } from "next/server";

import { rebindSessionOwnership } from "@/lib/ahp/ownership-recovery";
import { getDb } from "@/lib/db/schema";
import { getSessionOwnership } from "@/lib/db/session-ownership";
import { validateLocalEventStreamRequest, validateLocalMutationRequest } from "@/lib/http/local-mutation";

export async function GET(request: NextRequest) {
  const requestError = validateLocalEventStreamRequest(request);
  if (requestError) return NextResponse.json({ error: requestError }, { status: 403 });
  const sessionUri = request.nextUrl.searchParams.get("sessionUri")?.trim();
  if (!sessionUri) return NextResponse.json({ error: "sessionUri is required" }, { status: 400 });
  const ownership = getSessionOwnership(getDb(), sessionUri);
  if (!ownership) return NextResponse.json({ error: "Session ownership is unavailable" }, { status: 404 });
  return NextResponse.json(ownership, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: NextRequest) {
  const requestError = validateLocalMutationRequest(request);
  if (requestError) return NextResponse.json({ error: requestError }, { status: 403 });
  let body: Record<string, unknown> | null;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "A JSON object is required" }, { status: 400 });
  }
  const sessionUri = typeof body?.sessionUri === "string" ? body.sessionUri.trim() : "";
  const hostId = typeof body?.hostId === "string" ? body.hostId.trim() : "";
  const expectedRevision = body?.expectedRevision;
  if (!sessionUri || !hostId || typeof expectedRevision !== "number"
    || !Number.isSafeInteger(expectedRevision) || expectedRevision < 1 || body?.confirm !== true) {
    return NextResponse.json({
      error: "sessionUri, hostId, a positive expectedRevision and confirm: true are required",
    }, { status: 400 });
  }
  const result = await rebindSessionOwnership({
    sessionUri, hostId, expectedRevision, confirm: true,
  }, request.signal);
  const status = result.success ? 200 : result.reason === "not-found" ? 404
    : result.reason === "unknown-host" ? 400 : result.reason === "catalog-unavailable" ? 503 : 409;
  return NextResponse.json(result, { status, headers: { "Cache-Control": "no-store" } });
}
