import assert from "node:assert/strict";
import { test } from "node:test";

import Database from "better-sqlite3";

import { ensureCtoContinuitySchema } from "../db/cto-continuity-schema.ts";
import { CtoContinuityStore } from "../db/cto-continuity-store.ts";
import {
  authorizeAndRunOverride,
  getAuthoritativeApprovalBinding,
} from "./cto-override-authorization.ts";
import { getRiskFactsSnapshot } from "./risk-facts.ts";
import { setCardRiskInDb } from "./risk-persistence.ts";

function createDb() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE card_phases (
      card_id TEXT PRIMARY KEY,
      phase TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE card_risk (
      card_id TEXT PRIMARY KEY,
      risk_level TEXT NOT NULL,
      risk_factors TEXT NOT NULL,
      assessed_at TEXT NOT NULL,
      assessed_by TEXT NOT NULL,
      risk_digest TEXT
    );
    CREATE TABLE session_cache (
      session_uri TEXT PRIMARY KEY,
      host_url TEXT NOT NULL,
      summary_json TEXT NOT NULL,
      enrichment_json TEXT,
      updated_at TEXT NOT NULL
    );
  `);
  ensureCtoContinuitySchema(db);
  return db;
}

const args = {
  cardId: "card-1",
  targetPhase: "ship",
  reason: "Reviewed",
};

function seedFacts(db: Database.Database, riskLevel = "high") {
  db.exec(`
    INSERT INTO card_phases VALUES ('card-1', 'review', 'phase-v1');
    INSERT INTO session_cache VALUES (
      'card-1', 'http://localhost:1',
      '{"title":"Card 1","_planwerkRiskFacts":{"sourceRevision":"source-v1","planVersion":"plan-v1"}}',
      NULL, 'cache-v1'
    );
  `);
  const snapshot = getRiskFactsSnapshot(
    db,
    "http://localhost:1",
    "card-1",
  )!;
  setCardRiskInDb(
    db,
    "card-1",
    riskLevel as "low" | "medium" | "high",
    ["deployment"],
    "human",
    snapshot.digest,
  );
}

test("override authorization fails closed without persisted risk", () => {
  const db = createDb();
  db.prepare(
    "INSERT INTO card_phases VALUES ('card-1', 'review', 'phase-v1')"
  ).run();
  db.prepare(`
    INSERT INTO session_cache VALUES (
      'card-1', 'http://localhost:1', '{"title":"Card 1"}', NULL, 'cache-v1'
    )
  `).run();
  let mutated = false;
  const result = authorizeAndRunOverride({
    db,
    store: new CtoContinuityStore(db),
    args,
    sdkSessionId: "sdk-1",
    toolCallId: "call-1",
    mutate: () => {
      mutated = true;
    },
  });
  assert.equal(result.authorized, false);
  assert.equal(mutated, false);
  db.close();
});

test("legacy risk rows without a facts digest fail closed", () => {
  const db = createDb();
  db.exec(`
    INSERT INTO card_phases VALUES ('card-1', 'review', 'phase-v1');
    INSERT INTO session_cache VALUES (
      'card-1', 'http://localhost:1', '{"title":"Card 1"}', NULL, 'cache-v1'
    );
    INSERT INTO card_risk (
      card_id, risk_level, risk_factors, assessed_at, assessed_by, risk_digest
    ) VALUES (
      'card-1', 'low', '[]', 'risk-v1', 'copilot', NULL
    );
  `);

  const result = authorizeAndRunOverride({
    db,
    store: new CtoContinuityStore(db),
    args,
    sdkSessionId: "sdk-1",
    toolCallId: "call-1",
    mutate: () => assert.fail("legacy unversioned risk must not authorize"),
  });
  assert.equal(result.authorized, false);
  db.close();
});

test("override transaction rejects approval bound to stale authoritative facts", () => {
  const db = createDb();
  seedFacts(db);
  const store = new CtoContinuityStore(db);
  const binding = getAuthoritativeApprovalBinding(
    "override_phase",
    args,
    "sdk-1",
    db
  )!;
  const approval = store.requestApproval(
    binding,
    "cto-agent",
    60_000,
    "call-1"
  );
  store.decideApprovalWithCapability(
    approval.decisionCapability,
    "approved",
  );
  store.consumeApproval(binding, "call-1");
  db.prepare(`
    UPDATE card_phases SET phase = 'build', updated_at = 'phase-v2'
    WHERE card_id = 'card-1'
  `).run();

  let mutated = false;
  const result = authorizeAndRunOverride({
    db,
    store,
    args,
    sdkSessionId: "sdk-1",
    toolCallId: "call-1",
    mutate: () => {
      mutated = true;
    },
  });
  assert.equal(result.authorized, false);
  assert.equal(mutated, false);
  db.close();
});

test("matching approval authorizes the mutation atomically", () => {
  const db = createDb();
  seedFacts(db);
  const store = new CtoContinuityStore(db);
  const binding = getAuthoritativeApprovalBinding(
    "override_phase",
    args,
    "sdk-1",
    db
  )!;
  const approval = store.requestApproval(
    binding,
    "cto-agent",
    60_000,
    "call-1"
  );
  store.decideApprovalWithCapability(
    approval.decisionCapability,
    "approved",
  );
  store.consumeApproval(binding, "call-1");

  const result = authorizeAndRunOverride({
    db,
    store,
    args,
    sdkSessionId: "sdk-1",
    toolCallId: "call-1",
    mutate: () => {
      db.prepare(`
        UPDATE card_phases SET phase = 'ship', updated_at = 'phase-v2'
        WHERE card_id = 'card-1'
      `).run();
    },
  });
  assert.equal(result.authorized, true);
  assert.equal(
    (db.prepare(
      "SELECT phase FROM card_phases WHERE card_id = 'card-1'"
    ).get() as { phase: string }).phase,
    "ship"
  );
  db.close();
});

test("consumed approval fails closed after process-owner restart", () => {
  const db = createDb();
  seedFacts(db);
  const first = new CtoContinuityStore(
    db,
    () => 1_000,
    { ownerId: "process-a", ownerLeaseTtlMs: 100 },
  );
  const binding = getAuthoritativeApprovalBinding(
    "override_phase",
    args,
    "sdk-1",
    db,
  )!;
  const approval = first.requestApproval(binding, "cto-agent", 60_000, "call-1");
  first.decideApprovalWithCapability(
    approval.decisionCapability,
    "approved",
  );
  assert(first.consumeApproval(binding, "call-1"));

  let mutated = false;
  const restarted = new CtoContinuityStore(
    db,
    () => 1_001,
    { ownerId: "process-b", ownerLeaseTtlMs: 100 },
  );
  const redelivery = authorizeAndRunOverride({
    db,
    store: restarted,
    args,
    sdkSessionId: "sdk-1",
    toolCallId: "call-1",
    mutate: () => {
      mutated = true;
    },
  });
  assert.equal(redelivery.authorized, false);
  assert.equal(mutated, false);
  db.close();
});

test("consumed approval fails closed after its owner lease expires", () => {
  const db = createDb();
  seedFacts(db);
  let now = 2_000;
  const store = new CtoContinuityStore(
    db,
    () => now,
    { ownerId: "process-a", ownerLeaseTtlMs: 100 },
  );
  const binding = getAuthoritativeApprovalBinding(
    "override_phase",
    args,
    "sdk-1",
    db,
  )!;
  const approval = store.requestApproval(binding, "cto-agent", 60_000, "call-1");
  store.decideApprovalWithCapability(
    approval.decisionCapability,
    "approved",
  );
  assert(store.consumeApproval(binding, "call-1"));
  now = 2_101;

  const result = authorizeAndRunOverride({
    db,
    store,
    args,
    sdkSessionId: "sdk-1",
    toolCallId: "call-1",
    mutate: () => assert.fail("expired owner must not mutate"),
  });
  assert.equal(result.authorized, false);
  db.close();
});
