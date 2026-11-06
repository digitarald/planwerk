import assert from "node:assert/strict";
import { test } from "node:test";
import Database from "better-sqlite3";
import { ensureDecisionSchema, readDecision, writeDecision } from "./decision-store.ts";

test("decision migration is repeatable and records abstentions without storing source evidence", () => {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE card_risk (card_id TEXT PRIMARY KEY)");
  ensureDecisionSchema(db);
  ensureDecisionSchema(db);
  const outcome = { key: "evidence-hash", policyKey: "policy-hash", kind: "needs-human" as const,
    reason: "Insufficient evidence", latencyMs: 4 };
  writeDecision(db, "risk", '["host-a","card-a"]', outcome);
  assert.deepEqual(readDecision(db, outcome.key), outcome);
  assert.equal(readDecision(db, "host-b-hash"), undefined);
  assert.deepEqual(db.prepare("PRAGMA table_info(card_risk)").all().map((row) => (row as { name: string }).name),
    ["card_id", "decision_key", "decision_policy"]);
  db.close();
});
