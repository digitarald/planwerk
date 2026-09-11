import { NextRequest, NextResponse } from "next/server";

import {
  canAdvancePhase,
  completeGateRun,
  executeGateCommand,
  getCardPhase,
  getGatesForTransition,
  getNextPhase,
  logManualOverride,
  resolveConfiguredGate,
  setCardPhase,
  startGateRun,
  type GateType,
} from "@/lib/orchestrator/gate-engine";
import { getDb } from "@/lib/db/schema";
import {
  getAuthoritativeCardRisk,
  getRiskForAutomation,
} from "@/lib/orchestrator/risk-store";
import { validateLocalMutationRequest } from "@/lib/http/local-mutation";
import { resolveAuthoritativeGateRevision } from "@/lib/orchestrator/gate-revision";
import { advanceReviewToShip } from "@/lib/orchestrator/phase-advance";
import { loadConfig } from "@/lib/orchestrator/skill-config";
import {
  normalizeChangesetRef,
  PHASE_ORDER,
  type Phase,
  type RiskLevel,
} from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function getCardRiskLevel(cardId: string): RiskLevel | undefined {
  return getRiskForAutomation(cardId);
}

export async function POST(request: NextRequest) {
  const requestError = validateLocalMutationRequest(request);
  if (requestError) {
    return NextResponse.json({ error: requestError }, { status: 403 });
  }

  let body: {
    cardId?: string;
    action?: string;
    gateType?: GateType;
    gateName?: string;
    workingDirectory?: string;
    projectPath?: string;
    changesetRef?: string;
    toPhase?: Phase;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
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

  const authoritativeRevision = resolveAuthoritativeGateRevision(
    getDb(),
    cardId,
    currentPhase,
  );
  if (!authoritativeRevision.ok) {
    return NextResponse.json(
      {
        error: "Authoritative revision unavailable",
        detail: authoritativeRevision.reason,
        retryable: true,
      },
      { status: 409 },
    );
  }
  if (
    body.changesetRef !== undefined &&
    normalizeChangesetRef(body.changesetRef) !==
      normalizeChangesetRef(authoritativeRevision.changesetRef)
  ) {
    return NextResponse.json(
      {
        error: "Changeset revision does not match current AHP facts",
        stale: true,
      },
      { status: 409 },
    );
  }
  const changesetRef = authoritativeRevision.changesetRef;

  if (action === "check") {
    const riskLevel = getCardRiskLevel(cardId);
    const result = canAdvancePhase(
      cardId,
      currentPhase,
      nextPhase,
      body.projectPath,
      riskLevel,
      changesetRef
    );

    return NextResponse.json({
      cardId,
      currentPhase,
      nextPhase,
      ...result,
    });
  }

  if (action === "advance") {
    const authoritativeRisk = getAuthoritativeCardRisk(cardId);
    if (authoritativeRisk.status !== "current") {
      return NextResponse.json(
        {
          error: "Risk reassessment required before advancing",
          detail:
            "Reassess risk against the current authoritative card facts, then retry advancement.",
          riskStatus: authoritativeRisk.status,
          retryable: true,
        },
        { status: 409 }
      );
    }

    const riskLevel = authoritativeRisk.assessment.level;
    const { allowed, pendingGates } = canAdvancePhase(
      cardId,
      currentPhase,
      nextPhase,
      body.projectPath,
      riskLevel,
      changesetRef
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
    const configuredGate = resolveConfiguredGate({
      fromPhase: currentPhase,
      toPhase: nextPhase,
      gateType,
      gateName,
      projectPath: body.projectPath,
      riskLevel,
    });
    if (!configuredGate.ok) {
      return NextResponse.json(
        { error: configuredGate.reason },
        { status: 400 }
      );
    }
    const gate = configuredGate.gate;

    if (gate.gateType === "artifact" || gate.gateType === "review") {
      return NextResponse.json(
        {
          error:
            gate.gateType === "artifact"
              ? `${gate.artifactType ?? "Required"} artifact gates pass only after Planwerk reads the artifact`
              : "Review gates must run through the independent review executor",
        },
        { status: 409 }
      );
    }

    if (!gate.command) {
      return NextResponse.json(
        { error: `No command configured for gate "${gate.gateName ?? gate.gateType}"` },
        { status: 409 }
      );
    }

    const runId = startGateRun({
      cardId,
      fromPhase: currentPhase,
      toPhase: nextPhase,
      gateType: gate.gateType,
      gateName: gate.gateName,
      changesetRef,
    });

    // Commands are trusted project/admin configuration, never request input.
    const cwd = body.workingDirectory || process.cwd();
    executeGateCommand(runId, gate.command, cwd);

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
    const configuredGate = resolveConfiguredGate({
      fromPhase: currentPhase,
      toPhase: nextPhase,
      gateType: "human-approval",
      gateName,
      projectPath: body.projectPath,
      riskLevel,
    });
    if (!configuredGate.ok) {
      return NextResponse.json(
        { error: configuredGate.reason },
        { status: 400 }
      );
    }
    const gate = configuredGate.gate;

    const runId = startGateRun({
      cardId,
      fromPhase: currentPhase,
      toPhase: nextPhase,
      gateType: "human-approval",
      gateName: gate.gateName,
      changesetRef,
    });
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
  const authoritativeRevision = resolveAuthoritativeGateRevision(
    getDb(),
    cardId,
    currentPhase,
  );
  if (!authoritativeRevision.ok) {
    return NextResponse.json(
      {
        error: "Authoritative revision unavailable",
        detail: authoritativeRevision.reason,
        retryable: true,
      },
      { status: 409 },
    );
  }
  if (
    changesetRef !== undefined &&
    normalizeChangesetRef(changesetRef) !==
      normalizeChangesetRef(authoritativeRevision.changesetRef)
  ) {
    return NextResponse.json(
      {
        error: "Changeset revision does not match current AHP facts",
        stale: true,
      },
      { status: 409 },
    );
  }
  const { allowed, pendingGates } = canAdvancePhase(
    cardId,
    currentPhase,
    nextPhase,
    projectPath,
    riskLevel,
    authoritativeRevision.changesetRef
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
