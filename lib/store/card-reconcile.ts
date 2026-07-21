import type { KanbanCard } from "../types.ts";

/** Replace a server-projected card while retaining an explicit local phase override. */
export function replaceAuthoritativeCard(
  existing: KanbanCard,
  incoming: KanbanCard,
): KanbanCard {
  if (!existing.manualOverride) return incoming;
  return {
    ...incoming,
    phase: existing.phase,
    gateStatus: existing.gateStatus,
    manualOverride: true,
  };
}
