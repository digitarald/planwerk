import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { claimPlanAnswer, completePlanAnswer, ensurePlanAnswerSchema } from "./plan-answer-store.ts";

const answer = {
  hostUrl: "vscode-local://desktop", sessionUri: "ahp-session:/parent",
  requestId: "request", planRef: "plan:hash", action: "approve" as const,
};

test("one original request admits one plan answer, even if hash or action changes", () => {
  const db = new Database(":memory:");
  ensurePlanAnswerSchema(db);
  ensurePlanAnswerSchema(db);
  const owner = claimPlanAnswer(db, answer);
  assert(owner);
  assert.equal(claimPlanAnswer(db, answer), null);
  assert.equal(claimPlanAnswer(db, { ...answer, planRef: "plan:new", action: "feedback" }), null);
  completePlanAnswer(db, owner, true);
  assert.equal(claimPlanAnswer(db, answer), null);
  assert.equal((db.prepare("SELECT status FROM plan_answers").get() as { status: string }).status, "consumed");
  assert(claimPlanAnswer(db, { ...answer, hostUrl: "ws://another-host" }));
  db.close();
});

test("unknown consumption is durably ambiguous and cannot automatically replay", () => {
  const db = new Database(":memory:");
  ensurePlanAnswerSchema(db);
  const owner = claimPlanAnswer(db, answer);
  assert(owner);
  completePlanAnswer(db, owner, false, "Transport interrupted");
  assert.equal(claimPlanAnswer(db, answer), null);
  assert.deepEqual(db.prepare("SELECT status, detail FROM plan_answers").get(),
    { status: "ambiguous", detail: "Transport interrupted" });
  assert.throws(() => completePlanAnswer(db, owner, true), /ownership was lost/);
  db.close();
});
