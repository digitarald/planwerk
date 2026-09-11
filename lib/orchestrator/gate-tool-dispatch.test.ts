import assert from "node:assert/strict";
import { test } from "node:test";

import Database from "better-sqlite3";

import { MessageDispatchAmbiguousError } from "../ahp/dispatch-confirmation.ts";
import { ensureCtoContinuitySchema } from "../db/cto-continuity-schema.ts";
import { CtoContinuityStore } from "../db/cto-continuity-store.ts";
import { dispatchGateInstruction } from "./gate-tool-dispatch.ts";
import { persistToolHandlerOutcome } from "./tool-execution-disposition.ts";

function createGateHarness() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE gate_runs (
      id INTEGER PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'running',
      output TEXT
    );
    INSERT INTO gate_runs (id) VALUES (1);
  `);
  ensureCtoContinuitySchema(db);
  const store = new CtoContinuityStore(db);
  return {
    db,
    store,
    failGate(output: string) {
      db.prepare(`
        UPDATE gate_runs SET status = 'failed', output = ? WHERE id = 1
      `).run(output);
    },
  };
}

test("confirmed gate pre-dispatch failure is failed and retryable", async () => {
  const { db, store, failGate } = createGateHarness();
  const key = "trigger-gate:pre-dispatch";
  const args = { cardId: "card-1", gateType: "lint" };
  const claim = store.claimToolExecution(
    key,
    "trigger_gate",
    args,
    "owner-1",
    1_000,
  );
  assert.equal(claim.state, "claimed");

  const outcome = await dispatchGateInstruction({
    cardTitle: "Repair schema",
    gateType: "lint",
    gateRunId: 1,
    command: "npm run lint",
    inject: async () => ({ success: false }),
    failGate,
  });
  assert.equal(outcome.result.success, false);
  assert.equal(outcome.disposition, "retryable");
  persistToolHandlerOutcome(store, key, "owner-1", outcome);

  assert.deepEqual(
    db.prepare("SELECT status, output FROM gate_runs WHERE id = 1").get(),
    {
      status: "failed",
      output: "Gate instruction was not dispatched; retry this gate.",
    },
  );
  assert.equal(
    store.claimToolExecution(
      key,
      "trigger_gate",
      args,
      "owner-2",
      1_000,
    ).state,
    "claimed",
  );
  db.close();
});

test("ambiguous gate dispatch is failed once and cached as needs-human", async () => {
  const { db, store, failGate } = createGateHarness();
  const key = "trigger-gate:ambiguous";
  const args = { cardId: "card-1", gateType: "lint" };
  const claim = store.claimToolExecution(
    key,
    "trigger_gate",
    args,
    "owner-1",
    1_000,
  );
  assert.equal(claim.state, "claimed");
  let injections = 0;

  const outcome = await dispatchGateInstruction({
    cardTitle: "Repair schema",
    gateType: "lint",
    gateRunId: 1,
    command: "npm run lint",
    inject: async () => {
      injections++;
      throw new MessageDispatchAmbiguousError("ping failed");
    },
    failGate,
  });
  assert.equal(outcome.result.success, false);
  assert.equal(outcome.disposition, "needs-human");
  persistToolHandlerOutcome(store, key, "owner-1", outcome);

  assert.equal(
    (db.prepare("SELECT status FROM gate_runs WHERE id = 1").get() as {
      status: string;
    }).status,
    "failed",
  );
  const retry = store.claimToolExecution(
    key,
    "trigger_gate",
    args,
    "owner-2",
    1_000,
  );
  assert.equal(retry.state, "needs-human");
  assert.equal(injections, 1);
  db.close();
});
