import assert from "node:assert/strict";
import test from "node:test";

import type { KanbanCard } from "../types.ts";
import { replaceAuthoritativeCard } from "./card-reconcile.ts";

const baseCard = {
  id: "copilotcli:/card",
  title: "Card",
  phase: "plan",
  runtime: "idle",
  gateStatus: "evaluating",
  gateBlocker: "Plan review not started",
  attention: "none",
  risk: "low",
  activity: "",
  additions: 0,
  deletions: 0,
  filesChanged: 0,
  planSteps: { total: 0, done: 0 },
  modifiedAt: 0,
  isArchived: false,
} satisfies KanbanCard;

test("authoritative replacement clears derived fields omitted by the server", () => {
  const incoming = {
    ...baseCard,
    gateStatus: "failed",
    attention: "needs-human",
  } satisfies KanbanCard;
  delete (incoming as Partial<KanbanCard>).gateBlocker;

  const replaced = replaceAuthoritativeCard(baseCard, incoming);

  assert.equal(replaced.gateStatus, "failed");
  assert.equal(replaced.attention, "needs-human");
  assert.equal(replaced.gateBlocker, undefined);
});

test("authoritative replacement preserves an explicit local phase override", () => {
  const existing = {
    ...baseCard,
    phase: "build",
    gateStatus: "pending",
    manualOverride: true,
  } satisfies KanbanCard;
  const incoming = {
    ...baseCard,
    gateStatus: "failed",
  } satisfies KanbanCard;

  const replaced = replaceAuthoritativeCard(existing, incoming);

  assert.equal(replaced.phase, "build");
  assert.equal(replaced.gateStatus, "pending");
  assert.equal(replaced.manualOverride, true);
  assert.equal(replaced.runtime, incoming.runtime);
});
