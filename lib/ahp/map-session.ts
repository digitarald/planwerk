import { KanbanCard, Phase, RuntimeStatus } from "@/lib/types";

import { mockPhaseAssignments } from "./mock-sessions";
import { AHPSessionSummary, parseAHPStatus } from "./types";

export function mapAHPRuntimeStatus(statusBits: number): RuntimeStatus {
  const parsed = parseAHPStatus(statusBits);
  if (parsed.isError) return "error";
  if (parsed.isInputNeeded) return "input-needed";
  if (parsed.isInProgress) return "running";
  return "idle";
}

export function mapSessionToCard(
  session: AHPSessionSummary,
  existingPhase?: Phase
): KanbanCard {
  const runtime = mapAHPRuntimeStatus(session.status);
  // Use existing phase, then mock assignment, then default to "define"
  const phase = existingPhase || mockPhaseAssignments[session.resource] || "define";

  return {
    id: session.resource,
    title: session.title,
    phase,
    runtime,
    gateStatus: phase === "review" ? "evaluating" : phase === "ship" ? "passed" : "pending",
    attention:
      runtime === "input-needed"
        ? "needs-human"
        : runtime === "error"
          ? "error"
          : "none",
    risk: session.title.toLowerCase().includes("migration") || session.title.toLowerCase().includes("payment") ? "high" : "medium",
    activity: session.activity || "No activity",
    additions: session.changes?.additions || 0,
    deletions: session.changes?.deletions || 0,
    filesChanged: session.changes?.files || 0,
    planSteps: phase === "build" ? { total: 7, done: 4 } : phase === "plan" ? { total: 8, done: 2 } : phase === "review" ? { total: 5, done: 5 } : { total: 0, done: 0 },
    modifiedAt: new Date(session.modifiedAt).getTime(),
    model: session.model,
    branch: undefined,
    workingDirectory: session.workingDirectory,
  };
}
