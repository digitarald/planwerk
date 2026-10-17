import type { AutomationWait, KanbanCard } from "../types.ts";
import type { CoherenceDeferralReason, CoherenceWakeCondition } from "../orchestrator/coherence-detect.ts";

export function coherenceWait(
  reason: CoherenceDeferralReason | undefined,
  wake: CoherenceWakeCondition | undefined,
  retryAt?: number,
): AutomationWait {
  if (reason === "inactive-session") return {
    reason: "inactive", summary: "Overlap review is waiting for active sessions.",
    nextStep: "Review resumes when both sessions are active. Refreshing evidence alone cannot review cold code.",
  };
  if (reason === "evidence-limit") return {
    reason: "unsupported", summary: "This overlap exceeds automatic review limits.",
    nextStep: "Use an independent manual review. Partial evidence will not be marked coherent.",
  };
  if (reason === "source-changed") return {
    reason: "evidence", summary: "The overlap changed during review.",
    nextStep: "Review restarts when current evidence is available. Old verdicts cannot clear this overlap.",
  };
  if (reason === "infrastructure" || reason === "invalid-model-output" || reason === "evidence-unavailable") {
    return {
      reason: "service", summary: reason === "invalid-model-output"
        ? "The reviewer could not return a usable result." : "Review evidence or service is unavailable.",
      nextStep: wake === "manual"
        ? "Automatic retries have stopped. Use an independent manual review; no coherence verdict has been recorded."
        : "Planwerk will retry automatically. This is a system wait, not an approval request.",
      retryAt: wake === "retry-time" ? retryAt : undefined,
    };
  }
  return {
    reason: "review", summary: "Overlap review has not cleared.",
    nextStep: "Wait for the independent review. Only a current verdict can clear this overlap.",
  };
}

/** Presentation only: never used to authorize automation or gate advancement. */
export function automationWaitForCard(card: KanbanCard, overlap?: AutomationWait): AutomationWait | undefined {
  if (card.ownershipConflict) return {
    reason: "ownership", summary: "Two hosts claim this session.",
    nextStep: "Choose the host that owns this work. History stays intact; previous evidence and approvals will be invalidated.",
  };
  if (card.runtime === "input-needed" || card.runtime === "error" || card.phase === "ship") return undefined;
  if (overlap) return overlap;
  const requiredEvidenceMissing = card.phase === "plan" ? !card.planContentHash
    : (card.phase === "build" || card.phase === "review") && card.changesetVerified !== true;
  if ((card.evidence?.state !== "current" || requiredEvidenceMissing) && card.phase !== "define") return {
    reason: "evidence", summary: card.evidence?.state === "stale" ? "Evidence changed or is out of date." : "Current evidence has not been collected.",
    nextStep: card.runtime === "running"
      ? "Live evidence updates as the session works. You can also refresh it deliberately."
      : "Refresh evidence to collect plan, files, and outcome. No background read will restore this session.",
  };
  if (card.gateStatus === "pending" && card.gateBlocker) return {
    reason: "gate", summary: card.gateBlocker,
    nextStep: "Complete the required gate. Refreshing evidence does not approve or advance the card.",
  };
  return undefined;
}
