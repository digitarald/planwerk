import { NextRequest, NextResponse } from "next/server";

import {
  deriveGateStatus,
  getNextPhase,
  getPersistedPhases,
} from "@/lib/orchestrator/gate-engine";
import { getCardRisk } from "@/lib/orchestrator/risk-store";
import type { GateStatus } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Batch read of persisted card phase + derived gate status so the board can
 *  hydrate stored truth on load instead of re-deriving a default
 *  (board ↔ SQLite divergence fix). Only cards with a stored transition are
 *  returned; others keep their AHP-derived state. */
export async function GET(request: NextRequest) {
  const raw = request.nextUrl.searchParams.get("cardIds");
  const cardIds = raw
    ? raw.split(",").map((s) => s.trim()).filter(Boolean)
    : [];

  const phases = getPersistedPhases(cardIds);
  const states: Record<string, { phase: string; gateStatus: GateStatus }> = {};

  for (const [cardId, phase] of Object.entries(phases)) {
    const nextPhase = getNextPhase(phase);
    const gateStatus: GateStatus = nextPhase
      ? deriveGateStatus(cardId, phase, nextPhase, getCardRisk(cardId)?.level)
      : "passed";
    states[cardId] = { phase, gateStatus };
  }

  return NextResponse.json({ states });
}
