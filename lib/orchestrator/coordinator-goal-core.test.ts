import assert from "node:assert/strict";
import { test } from "node:test";
import { coordinatorOutcomeDigest, goalDependenciesReady, hasNewGoalResult } from "./coordinator-goal-core.ts";
import type { CoordinatorGoal, GoalWorkItem } from "./coordinator-goal-types.ts";
import type { KanbanCard } from "../types.ts";

const card: KanbanCard = { id: "worker", title: "Worker", phase: "build", runtime: "idle",
  gateStatus: "pending", attention: "none", risk: "low", activity: "", additions: 0, deletions: 0,
  filesChanged: 0, planSteps: { total: 0, done: 0 }, modifiedAt: 1, sourceRevision: "new", lastAgentMessage: "API ready" };
card.outcomeEvidence = { chatUri: "chat", turnId: "turn", state: "complete", text: "API ready", truncated: false };
const work: GoalWorkItem = { id: "a", goalId: "goal", instructions: "Build API", acceptanceCriteria: "API works",
  workingDirectory: "/workspace", cardId: card.id, actionKey: "a", state: "awaiting-result", dependencies: [],
  delivery: { chatUri: "chat", turnId: "turn" },
  baseline: coordinatorOutcomeDigest({ ...card, lastAgentMessage: "Old result" }) };

test("idle, timestamps, queue acceptance and unchanged outcomes are not new results", () => {
  assert.equal(hasNewGoalResult(work, card), true);
  assert.equal(hasNewGoalResult(work, { ...card, runtime: "running" }), false);
  assert.equal(hasNewGoalResult({ ...work, state: "queued" }, card), false);
  assert.equal(hasNewGoalResult({ ...work, state: "uncertain" }, card), false);
  assert.equal(hasNewGoalResult(work, { ...card, outcomeEvidence: undefined }), false);
  assert.equal(hasNewGoalResult(work, { ...card, outcomeEvidence: { ...card.outcomeEvidence!, turnId: "someone-elses-turn" } }), false);
  assert.equal(hasNewGoalResult(work, { ...card, outcomeEvidence: { ...card.outcomeEvidence!, truncated: true } }), false);
  assert.equal(hasNewGoalResult({ ...work, baseline: coordinatorOutcomeDigest(card) }, { ...card, modifiedAt: 9999 }), false);
});

test("A result releases informational B, verification releases verified B, and drift blocks both", () => {
  const parent: GoalWorkItem = { ...work, state: "awaiting-result", outcome: card.lastAgentMessage,
    evidence: { digest: coordinatorOutcomeDigest(card), accepted: true, verified: false, observedAt: "now" } };
  const child: GoalWorkItem = { ...work, id: "b", dependencies: [{ itemId: "a", kind: "result" }] };
  const goal: CoordinatorGoal = { id: "goal", hostUrl: "host", workspaceScope: ["/workspace"],
    objective: "Integrate", acceptanceCriteria: "Works", state: "active", revision: 1, items: [parent, child] };
  assert.equal(goalDependenciesReady(goal, child, [card]), true);
  child.dependencies = [{ itemId: "a", kind: "verified" }];
  assert.equal(goalDependenciesReady(goal, child, [card]), false);
  parent.state = "completed";
  parent.evidence!.verified = true;
  assert.equal(goalDependenciesReady(goal, child, [card]), true);
  assert.equal(goalDependenciesReady(goal, child, [{ ...card, sourceRevision: "changed" }]), false);
  assert.equal(goalDependenciesReady(goal, child, []), false);
});
