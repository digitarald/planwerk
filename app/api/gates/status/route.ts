import { NextRequest, NextResponse } from "next/server";

import { getGateRunsForCard } from "@/lib/orchestrator/gate-engine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const cardId = request.nextUrl.searchParams.get("cardId");

  if (!cardId) {
    return NextResponse.json(
      { error: "cardId required" },
      { status: 400 }
    );
  }

  const runs = getGateRunsForCard(cardId);
  return NextResponse.json({ cardId, runs });
}
