import { KanbanCard, Phase, RuntimeStatus } from "@/lib/types";

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

  return {
    id: session.resource,
    title: session.title,
    phase: existingPhase || "define",
    runtime,
    gateStatus: "pending",
    attention:
      runtime === "input-needed"
        ? "needs-human"
        : runtime === "error"
          ? "error"
          : "none",
    risk: "medium",
    activity: session.activity || "No activity",
    additions: session.changes?.additions || 0,
    deletions: session.changes?.deletions || 0,
    filesChanged: session.changes?.files || 0,
    planSteps: { total: 0, done: 0 },
    modifiedAt: new Date(session.modifiedAt).getTime(),
    model: session.model,
    branch: undefined,
    workingDirectory: session.workingDirectory,
  };
}
