import { exec } from "node:child_process";

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
import { getCardRisk } from "@/lib/orchestrator/risk-store";
import type { RiskLevel } from "@/lib/types";

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
      const maxOutput = 64 * 1024;

      try {
        exec(
          gate.command,
          {
            cwd,
            timeout: 5 * 60 * 1000,
            maxBuffer: maxOutput,
          },
          (error, stdout, stderr) => {
            if (error) {
              const output = (stderr || stdout || error.message).slice(0, maxOutput);
              completeGateRun(runId, "failed", output);
            } else {
              const output = (stdout || "All checks passed").slice(0, maxOutput);
              completeGateRun(runId, "passed", output);
            }
          }
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to start gate command";
        completeGateRun(runId, "failed", message);
      }
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
