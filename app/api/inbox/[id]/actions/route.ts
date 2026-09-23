import { NextRequest, NextResponse } from "next/server";

import { validateLocalMutationRequest } from "@/lib/http/local-mutation";
import {
  parseInboxActionBody,
  parseInboxHostUrl,
} from "@/lib/inbox/api";
import { serializeInboxActionResponse } from "@/lib/inbox/contract";
import { performInboxAction } from "@/lib/inbox/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const requestError = validateLocalMutationRequest(request);
  if (requestError) {
    return NextResponse.json({ error: requestError }, { status: 403 });
  }
  const host = parseInboxHostUrl(request.nextUrl.searchParams.get("host"));
  if (!host.ok) {
    return NextResponse.json({ error: host.error }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "request body must be valid JSON" },
      { status: 400 },
    );
  }
  const parsed = parseInboxActionBody(body);
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }

  const { id } = await params;
  const result = performInboxAction(
    id,
    parsed.value.action,
    null,
    parsed.value.snoozedUntil,
    host.value,
  );
  if (!result.ok && result.reason === "not-found") {
    return NextResponse.json(
      { error: "Inbox item not found" },
      { status: 404 },
    );
  }
  if (!result.ok) {
    return NextResponse.json(
      { error: "Inbox item does not belong to the requested AHP host" },
      { status: 409 },
    );
  }
  return NextResponse.json(serializeInboxActionResponse(result.item));
}
