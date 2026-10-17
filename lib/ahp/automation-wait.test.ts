import assert from "node:assert/strict";
import test from "node:test";
import { automationWaitForCard, coherenceWait } from "./automation-wait.ts";
import type { KanbanCard } from "../types.ts";

const card: KanbanCard = {
  id: "a", title: "A", phase: "build", runtime: "idle", risk: "high", attention: "stale",
  gateStatus: "pending", activity: "", additions: 0, deletions: 0, filesChanged: 0,
  planSteps: { total: 0, done: 0 }, modifiedAt: 0,
};
test("ownership, missing evidence, unsupported reviews and service waits offer distinct next steps", () => {
  assert.equal(automationWaitForCard({ ...card, ownershipConflict: true })?.reason, "ownership");
  assert.equal(automationWaitForCard(card)?.reason, "evidence");
  assert.match(automationWaitForCard(card)!.nextStep, /No background read/);
  assert.equal(coherenceWait("inactive-session", "activation-change").reason, "inactive");
  assert.equal(coherenceWait("evidence-limit", "signature-change").reason, "unsupported");
  const service = coherenceWait("infrastructure", "retry-time", 123);
  assert.equal(service.reason, "service");
  assert.equal(service.retryAt, 123);
  assert.match(service.nextStep, /not an approval/);
  const manual = coherenceWait("invalid-model-output", "manual", 123);
  assert.equal(manual.retryAt, undefined);
  assert.match(manual.nextStep, /retries have stopped/);
});
test("system waits never replace real input or runtime errors with generic approval controls", () => {
  for (const runtime of ["input-needed", "error"] as const) {
    assert.equal(automationWaitForCard({ ...card, runtime }, coherenceWait("infrastructure", "retry-time")), undefined);
  }
  assert.equal(automationWaitForCard({ ...card, phase: "ship" }), undefined);
  const current = { ...card, changesetVerified: true, evidence: { state: "current" as const }, gateBlocker: "Plan review pending" };
  assert.equal(automationWaitForCard(current)?.reason, "gate");
  assert.match(automationWaitForCard(current)!.nextStep, /does not approve/);
  assert.equal(automationWaitForCard({ ...current, changesetVerified: false })?.reason, "evidence");
});
