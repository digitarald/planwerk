import { createHash } from "node:crypto";
import type { KanbanCard } from "../types.ts";
import type { CoordinatorGoal, GoalWorkItem } from "./coordinator-goal-types.ts";

export function coordinatorOutcomeDigest(card: KanbanCard): string {
  return createHash("sha256").update(JSON.stringify([
    card.id, card.lastAgentMessage, card.outcomeEvidence, card.runtimeError, card.sourceRevision, card.planContentHash,
  ])).digest("hex");
}

export function goalDependenciesReady(goal: CoordinatorGoal, item: GoalWorkItem, cards: KanbanCard[]): boolean {
  return item.dependencies.every((edge) => {
    const parent = goal.items.find((candidate) => candidate.id === edge.itemId);
    const card = cards.find((candidate) => candidate.id === parent?.cardId);
    return Boolean(parent?.evidence?.accepted && parent.outcome && card?.runtime === "idle" &&
      coordinatorOutcomeDigest(card) === parent.evidence.digest &&
      (edge.kind === "result" || (parent.state === "completed" && parent.evidence.verified)));
  });
}

export function hasNewGoalResult(item: GoalWorkItem, card: KanbanCard): boolean {
  return Boolean(item.state !== "uncertain" && item.state !== "queued" && item.state !== "ready" && item.state !== "blocked" && item.state !== "completed" &&
    card.runtime === "idle" && !card.pendingInput && card.outcomeEvidence && !card.outcomeEvidence.truncated &&
    item.delivery?.chatUri === card.outcomeEvidence.chatUri && item.delivery?.turnId === card.outcomeEvidence.turnId &&
    coordinatorOutcomeDigest(card) !== item.baseline);
}
