import { NextRequest, NextResponse } from "next/server";

import { getCardStatusHistory } from "@/lib/orchestrator/status-history-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

/** Read a card's persisted status-line history for the detail modal's fuller
 *  timeline. Returns entries oldest→newest. */
export async function GET(request: NextRequest) {
  const cardId = request.nextUrl.searchParams.get("cardId");
  if (!cardId) {
    return NextResponse.json({ error: "cardId is required" }, { status: 400 });
  }

  const rawLimit = Number(request.nextUrl.searchParams.get("limit"));
  const limit = Number.isFinite(rawLimit) && rawLimit > 0
    ? Math.min(Math.floor(rawLimit), MAX_LIMIT)
    : DEFAULT_LIMIT;

  const entries = getCardStatusHistory(cardId, limit);
  return NextResponse.json({ entries });
}
