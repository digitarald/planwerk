import { NextRequest, NextResponse } from "next/server";

import { dismissConflict } from "@/lib/orchestrator/coherence-engine";
import { validateLocalMutationRequest } from "@/lib/http/local-mutation";
import { getDb } from "@/lib/db/schema";
import { resolveAuthoritativeGateRevision } from "@/lib/orchestrator/gate-revision";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * "Accept divergence": a human dismisses a coherence conflict between two cards
 * for its current signature. Logged as a manual override; a later materially
 * different overlap (new signature) reopens the pair.
 */
export async function POST(request: NextRequest) {
  const requestError = validateLocalMutationRequest(request);
  if (requestError) {
    return NextResponse.json({ error: requestError }, { status: 403 });
  }

  const body = (await request.json()) as { cardId?: string; otherCardId?: string };
  const { cardId, otherCardId } = body;

  if (!cardId || !otherCardId) {
    return NextResponse.json({ error: "cardId and otherCardId required" }, { status: 400 });
  }

  const source = resolveAuthoritativeGateRevision(getDb(), cardId, "build");
  const row = source.ok ? dismissConflict(cardId, otherCardId, source.hostUrl) : null;
  if (!row) {
    return NextResponse.json({ error: "No coherence conflict found for this pair" }, { status: 404 });
  }

  return NextResponse.json({
    status: "dismissed",
    pair: { cardA: row.cardA, cardB: row.cardB },
    dismissedSignature: row.dismissedSignature,
  });
}
