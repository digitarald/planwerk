import type { KanbanCard } from "../types.ts";

type AutomationEligibilityCard = Pick<
  KanbanCard,
  "isArchived" | "phase" | "runtime"
>;

export function isCardAutomationEligible(
  card: AutomationEligibilityCard,
): boolean {
  return (
    !card.isArchived
    && card.phase !== "ship"
    && card.runtime !== "error"
    && (card.phase !== "define" || card.runtime === "input-needed")
  );
}
