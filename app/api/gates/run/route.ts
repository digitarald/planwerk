import { NextRequest, NextResponse } from "next/server";

import {
  canAdvancePhase,
  completeGateRun,
  getCardPhase,
  getGatesForTransition,
  getNextPhase,
  setCardPhase,
  startGateRun,
  type GateType,
} from "@/lib/orchestrator/gate-engine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const body = (await request.json()) as {
    cardId?: string;
    action?: string;
    gateType?: GateType;
  };
  const { cardId, action } = body;

  if (!cardId) {
    return NextResponse.json({ error: "cardId required" }, { status: 400 });
  }

  const currentPhase = getCardPhase(cardId);
  const nextPhase = getNextPhase(currentPhase);

  if (!nextPhase) {
    return NextResponse.json({ error: "Already at final phase" }, { status: 400 });
  }

  if (action === "check") {
    const result = canAdvancePhase(cardId, currentPhase, nextPhase);

    return NextResponse.json({
      cardId,
      currentPhase,
      nextPhase,
      ...result,
    });
  }

  if (action === "advance") {
    const { allowed, pendingGates } = canAdvancePhase(
      cardId,
      currentPhase,
      nextPhase
    );

    if (!allowed) {
      return NextResponse.json(
        {
          error: "Gates not passed",
          pendingGates,
        },
        { status: 403 }
      );
    }

    setCardPhase(cardId, nextPhase);

    return NextResponse.json({
      cardId,
      previousPhase: currentPhase,
      newPhase: nextPhase,
    });
  }

  if (action === "run-gate") {
    const { gateType } = body;

    if (!gateType) {
      return NextResponse.json({ error: "gateType required" }, { status: 400 });
    }

    const runId = startGateRun(cardId, currentPhase, nextPhase, gateType);

    setTimeout(() => {
      const passed = Math.random() > 0.3;
      completeGateRun(
        runId,
        passed ? "passed" : "failed",
        passed
          ? "All checks passed"
          : "2 lint errors found in src/auth/middleware.ts"
      );
    }, 2000);

    return NextResponse.json({ runId, status: "running" });
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}

export async function GET(request: NextRequest) {
  const cardId = request.nextUrl.searchParams.get("cardId");

  if (!cardId) {
    return NextResponse.json({ error: "cardId required" }, { status: 400 });
  }

  const currentPhase = getCardPhase(cardId);
  const nextPhase = getNextPhase(currentPhase);

  if (!nextPhase) {
    return NextResponse.json({
      cardId,
      currentPhase,
      nextPhase: null,
      gates: [],
      allowed: true,
    });
  }

  const gates = getGatesForTransition(currentPhase, nextPhase);
  const { allowed, pendingGates } = canAdvancePhase(
    cardId,
    currentPhase,
    nextPhase
  );

  return NextResponse.json({
    cardId,
    currentPhase,
    nextPhase,
    gates,
    pendingGates,
    allowed,
  });
}
