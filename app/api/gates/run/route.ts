import { execFile } from "node:child_process";

import { NextRequest, NextResponse } from "next/server";

import { getDb } from "@/lib/db/schema";
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

try {
  const db = getDb();
  db.prepare(
    "UPDATE gate_runs SET status = 'failed', output = 'Abandoned: server restarted', completed_at = datetime('now') WHERE status = 'running'"
  ).run();
} catch {
  // DB may not be initialized yet on first load
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const body = (await request.json()) as {
    cardId?: string;
    action?: string;
    gateType?: GateType;
    gateName?: string;
    workingDirectory?: string;
    projectPath?: string;
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
    const result = canAdvancePhase(cardId, currentPhase, nextPhase, body.projectPath);

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
      nextPhase,
      body.projectPath
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

    const runId = startGateRun(
      cardId,
      currentPhase,
      nextPhase,
      gateType,
      gateName
    );

    const gates = getGatesForTransition(currentPhase, nextPhase, body.projectPath);
    const gate = gates.find(
      (g) => g.gateType === gateType && (!gateName || g.gateName === gateName)
    );

    if (!gate?.command) {
      completeGateRun(runId, "passed", "Manual review gate — no command to execute");
    } else {
      const cwd = body.workingDirectory || process.cwd();
      const maxOutput = 64 * 1024;

      execFile(
        "sh",
        ["-c", gate.command],
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
    }

    return NextResponse.json({ runId, status: "running" });
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}

export async function GET(request: NextRequest) {
  const cardId = request.nextUrl.searchParams.get("cardId");
  const projectPath = request.nextUrl.searchParams.get("projectPath") || undefined;

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

  const gates = getGatesForTransition(currentPhase, nextPhase, projectPath);
  const { allowed, pendingGates } = canAdvancePhase(
    cardId,
    currentPhase,
    nextPhase,
    projectPath
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
