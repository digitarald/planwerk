import { NextRequest, NextResponse } from "next/server";

import {
  canAdvancePhase,
  completeGateRun,
  executeGateCommand,
  getCardPhase,
  getGatesForTransition,
  getNextPhase,
  logManualOverride,
  setCardPhase,
  startGateRun,
  type GateType,
} from "@/lib/orchestrator/gate-engine";
import { getCardRisk } from "@/lib/orchestrator/risk-store";
import { advanceReviewToShip } from "@/lib/orchestrator/phase-advance";
import { loadConfig } from "@/lib/orchestrator/skill-config";
import { PHASE_ORDER, type Phase, type RiskLevel } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function getCardRiskLevel(cardId: string): RiskLevel | undefined {
  const risk = getCardRisk(cardId);
  return risk?.level;
}

export async function POST(request: NextRequest) {
  const body = (await request.json()) as {
    cardId?: string;
    action?: string;
    gateType?: GateType;
    gateName?: string;
    workingDirectory?: string;
    projectPath?: string;
    changesetRef?: string;
    toPhase?: Phase;
  };
  const { cardId, action } = body;

  if (!cardId) {
    return NextResponse.json({ error: "cardId required" }, { status: 400 });
  }

  const currentPhase = getCardPhase(cardId);

  // Explicit phase transition from a drag-and-drop move. Handled before the
  // "final phase" guard so cards can always be dragged back for rework.
  // The board is a management surface: human overrides are allowed but audited,
  // and forward moves still leave gate enforcement to the gate engine.
  if (action === "transition") {
    const { toPhase } = body;
    if (!toPhase || !PHASE_ORDER.includes(toPhase)) {
      return NextResponse.json({ error: "valid toPhase required" }, { status: 400 });
    }

    const fromIdx = PHASE_ORDER.indexOf(currentPhase);
    const toIdx = PHASE_ORDER.indexOf(toPhase);

    if (fromIdx === toIdx) {
      return NextResponse.json({
        cardId,
        previousPhase: currentPhase,
        newPhase: currentPhase,
        gateStatus: "pending",
        manualOverride: false,
        direction: "none",
      });
    }

    const direction = toIdx > fromIdx ? "forward" : "backward";
    setCardPhase(cardId, toPhase);
    logManualOverride(cardId, currentPhase, toPhase, direction);

    return NextResponse.json({
      cardId,
      previousPhase: currentPhase,
      newPhase: toPhase,
      // A drag is a manual override: it does not run the skipped transition's
      // gates. Report "pending" (verification still owed) rather than a fake
      // "evaluating" — gates are enforced separately by the orchestrator.
      gateStatus: "pending",
      manualOverride: direction === "forward",
      direction,
    });
  }

  const nextPhase = getNextPhase(currentPhase);

  if (!nextPhase) {
    return NextResponse.json({ error: "Already at final phase" }, { status: 400 });
  }

  if (action === "check") {
    const riskLevel = getCardRiskLevel(cardId);
    const result = canAdvancePhase(
      cardId,
      currentPhase,
      nextPhase,
      body.projectPath,
      riskLevel,
      body.changesetRef
    );

    return NextResponse.json({
      cardId,
      currentPhase,
      nextPhase,
      ...result,
    });
  }

  if (action === "advance") {
    const riskLevel = getCardRiskLevel(cardId);
    const { allowed, pendingGates } = canAdvancePhase(
      cardId,
      currentPhase,
      nextPhase,
      body.projectPath,
      riskLevel,
      body.changesetRef
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

    // Coherence choke point: a review→ship advance must clear board-level
    // coherence blocking (high-risk conflicts), not just the vertical gates.
    if (currentPhase === "review" && nextPhase === "ship") {
      const coherenceConfig = loadConfig(body.projectPath).coherence;
      const { advanced, blockedBy } = advanceReviewToShip(cardId, coherenceConfig);
      if (!advanced) {
        return NextResponse.json(
          {
            error: "Blocked by unresolved coherence conflict",
            coherenceConflicts: blockedBy.map((c) => ({
              with: c.cardA === cardId ? c.cardB : c.cardA,
              tier: c.tier,
              status: c.status,
              summary: c.verdictSummary,
            })),
          },
          { status: 409 }
        );
      }
      return NextResponse.json({ cardId, previousPhase: currentPhase, newPhase: nextPhase });
    }

    setCardPhase(cardId, nextPhase);

    return NextResponse.json({
      cardId,
      previousPhase: currentPhase,
      newPhase: nextPhase,
    });
  }

  if (action === "run-gate") {
    const { gateType, gateName } = body;

    if (!gateType) {
      return NextResponse.json({ error: "gateType required" }, { status: 400 });
    }

    const riskLevel = getCardRiskLevel(cardId);
    const gates = getGatesForTransition(
      currentPhase,
      nextPhase,
      body.projectPath,
      riskLevel
    );
    const gate = gates.find(
      (g) => g.gateType === gateType && (!gateName || g.gateName === gateName)
    );

    if (!gate) {
      return NextResponse.json(
        { error: `No configured gate matches type "${gateType}"${gateName ? ` name "${gateName}"` : ""}` },
        { status: 400 }
      );
    }

    const runId = startGateRun(
      cardId,
      currentPhase,
      nextPhase,
      gateType,
      gateName,
      body.changesetRef
    );

    if (!gate.command) {
      completeGateRun(runId, "passed", "Manual review gate — no command to execute");
    } else {
      // gate.command is trusted: sourced from DEFAULT_GATES or admin gate_configs table
      const cwd = body.workingDirectory || process.cwd();
      executeGateCommand(runId, gate.command, cwd);
    }

    return NextResponse.json({ runId, status: "running" });
  }

  if (action === "approve") {
    const { gateType, gateName } = body;

    if (gateType !== "human-approval") {
      return NextResponse.json(
        { error: "approve action only valid for human-approval gates" },
        { status: 400 }
      );
    }

    const riskLevel = getCardRiskLevel(cardId);
    const gates = getGatesForTransition(
      currentPhase,
      nextPhase,
      body.projectPath,
      riskLevel
    );
    const gate = gates.find(
      (g) => g.gateType === "human-approval" && (!gateName || g.gateName === gateName)
    );

    if (!gate) {
      return NextResponse.json(
        { error: "No human-approval gate found for this transition" },
        { status: 400 }
      );
    }

    const runId = startGateRun(
      cardId,
      currentPhase,
      nextPhase,
      "human-approval",
      gate.gateName ?? gateName,
      body.changesetRef
    );
    completeGateRun(runId, "passed", "Approved by human");

    return NextResponse.json({
      runId,
      status: "passed",
      approvedAt: new Date().toISOString(),
    });
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}

export async function GET(request: NextRequest) {
  const cardId = request.nextUrl.searchParams.get("cardId");
  const projectPath = request.nextUrl.searchParams.get("projectPath") || undefined;
  const changesetRef = request.nextUrl.searchParams.get("changesetRef") || undefined;

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

  const riskLevel = getCardRiskLevel(cardId);
  const gates = getGatesForTransition(currentPhase, nextPhase, projectPath, riskLevel);
  const { allowed, pendingGates } = canAdvancePhase(
    cardId,
    currentPhase,
    nextPhase,
    projectPath,
    riskLevel,
    changesetRef
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
