import type { GateStatus, RuntimeStatus } from "@/lib/types";

/**
 * The board reads on two independent axes, and this module is the single source
 * of truth for how each is worded — so the card, the detail modal, and any
 * tooltip speak exactly one label per state and never drift:
 *
 *  - **Runtime** answers *"what is the agent doing right now?"* It changes on its
 *    own as the session runs and never moves a card between columns.
 *  - **Gates** answer *"is this work allowed to advance a phase?"* Only a gate
 *    verdict advances a card, and a different reviewer produces it.
 *
 * A runtime `error` and a gate `failed` are both red, so the hints name their
 * axis explicitly ("Agent…" vs "Gate…") to keep the two readings apart. `label`
 * is the terse on-surface word; `hint` is the full-sentence tooltip.
 */

export const RUNTIME_STATUS: Record<RuntimeStatus, { label: string; hint: string }> = {
  running: { label: "Running", hint: "Agent is working" },
  idle: { label: "Idle", hint: "Agent is paused — no active work" },
  "input-needed": { label: "Needs input", hint: "Agent needs your input to continue" },
  error: { label: "Error", hint: "Agent hit an error" },
};

export const GATE_STATUS: Record<GateStatus, { label: string; hint: string }> = {
  pending: { label: "Not checked", hint: "Gates haven't run for this phase yet" },
  evaluating: { label: "Checking", hint: "Gates are checking this phase" },
  passed: { label: "Passed", hint: "Gates passed — clear to advance" },
  failed: { label: "Failed", hint: "A gate failed — blocked from advancing" },
};

/** Consistent phrasing for the "why this card can't advance" reason, shared by
 *  the card tooltip and the detail modal. `reason` is the human-readable
 *  gate-blocker text (e.g. "Plan review not started"). */
export function blockedFromAdvancingHint(reason: string): string {
  return `Blocked from advancing: ${reason}`;
}
