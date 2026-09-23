import type {
  InboxItemKind,
  InboxPriorityBand,
} from "./types.ts";

const KIND_PRIORITY: Record<
  InboxItemKind,
  { band: InboxPriorityBand; rank: number }
> = {
  "runtime-error": { band: "urgent", rank: 400 },
  "review-escalation": { band: "urgent", rank: 390 },
  conflict: { band: "urgent", rank: 380 },
  "pending-input": { band: "high", rank: 300 },
  "gate-failure": { band: "high", rank: 290 },
  "ship-ready": { band: "high", rank: 280 },
  "review-ready": { band: "normal", rank: 200 },
  completion: { band: "normal", rank: 190 },
  "coordinator-action": { band: "low", rank: 100 },
};

export function priorityForInboxKind(
  kind: InboxItemKind,
): { band: InboxPriorityBand; rank: number } {
  return KIND_PRIORITY[kind];
}
