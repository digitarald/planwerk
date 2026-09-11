import assert from "node:assert/strict";
import { test } from "node:test";

import Database from "better-sqlite3";

import {
  readAuthoritativeRisk,
  riskAutomationPolicy,
} from "./risk-authority.ts";
import { getRiskFactsSnapshot } from "./risk-facts.ts";
import { setCardRiskInDb } from "./risk-persistence.ts";

function createRiskDb() {
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
      assessed_at TEXT NOT NULL DEFAULT (datetime('now')),
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
    INSERT INTO card_phases VALUES ('card-1', 'plan', 'phase-v1');
    INSERT INTO session_cache VALUES (
      'card-1',
      'vscode-local://desktop',
      '{"title":"Small documentation fix","changes":{"files":1,"additions":2,"deletions":1},"_planwerkRiskFacts":{"sourceRevision":"source-v1","planVersion":"plan-v1"}}',
      '{"changesetVerified":true,"totalFileCount":1,"additions":2,"deletions":1,"fileChanges":[{"path":"README.md"}],"_planwerkSource":{"sourceRevision":"source-v1","planVersion":"plan-v1"}}',
      'cache-v1'
    );
  `);
  return db;
}

function seedFreshLow(db: Database.Database) {
  const snapshot = getRiskFactsSnapshot(
    db,
    "vscode-local://desktop",
    "card-1",
  );
  assert.ok(snapshot);
  setCardRiskInDb(
    db,
    "card-1",
    "low",
    ["Small documentation change"],
    "copilot",
    snapshot.digest,
  );
}

test("fresh matching low risk preserves low-risk automation policy", () => {
  const db = createRiskDb();
  seedFreshLow(db);

  const risk = readAuthoritativeRisk(
    db,
    "card-1",
    "vscode-local://desktop",
  );
  assert.equal(risk.status, "current");
  assert.deepEqual(riskAutomationPolicy(risk), {
    current: true,
    level: "low",
  });
  assert.ok(risk.assessment.riskDigest);

  db.prepare(`
    UPDATE session_cache SET updated_at = 'cache-v2'
    WHERE session_uri = 'card-1'
  `).run();
  assert.equal(
    readAuthoritativeRisk(db, "card-1").status,
    "current",
    "cache rewrites with unchanged risk facts must not create blocker loops",
  );
  db.close();
});

test("facts changing after low risk blocks auto-answer and plan approval and selects high-risk gates and reviewers", () => {
  const db = createRiskDb();
  seedFreshLow(db);

  db.prepare(`
    UPDATE session_cache
    SET summary_json =
      '{"title":"Authentication migration","changes":{"files":12,"additions":400,"deletions":80},"_planwerkRiskFacts":{"sourceRevision":"source-v2","planVersion":"plan-v2"}}',
      updated_at = 'cache-v2'
    WHERE session_uri = 'card-1'
  `).run();

  const risk = readAuthoritativeRisk(
    db,
    "card-1",
    "vscode-local://desktop",
  );
  assert.equal(risk.status, "stale");
  const policy = riskAutomationPolicy(risk);
  assert.equal(policy.current, false, "auto-answer and plan approval must stop");
  assert.equal(policy.level, "high", "gate/reviewer selection must fail closed");
  assert.match(policy.reason ?? "", /stale/);
  db.close();
});

test("legacy null-digest risk fails closed", () => {
  const db = createRiskDb();
  db.prepare(`
    INSERT INTO card_risk (
      card_id, risk_level, risk_factors, assessed_by, risk_digest
    ) VALUES ('card-1', 'low', '["Legacy low"]', 'copilot', NULL)
  `).run();

  const risk = readAuthoritativeRisk(db, "card-1");
  assert.equal(risk.status, "unbound");
  assert.deepEqual(riskAutomationPolicy(risk), {
    current: false,
    level: "high",
    reason: "Risk assessment is legacy or unbound to current facts.",
  });
  db.close();
});

test("missing assessment is explicit and fails closed", () => {
  const db = createRiskDb();
  const risk = readAuthoritativeRisk(db, "card-1");
  assert.equal(risk.status, "missing");
  assert.equal(riskAutomationPolicy(risk).level, "high");
  assert.equal(riskAutomationPolicy(risk).current, false);
  db.close();
});

test("missing authoritative facts are explicit and fail closed", () => {
  const db = createRiskDb();
  seedFreshLow(db);
  db.prepare("DELETE FROM session_cache WHERE session_uri = 'card-1'").run();

  const risk = readAuthoritativeRisk(db, "card-1");
  assert.equal(risk.status, "facts-unavailable");
  assert.equal(riskAutomationPolicy(risk).level, "high");
  assert.equal(riskAutomationPolicy(risk).current, false);
  db.close();
});

test("digest-bound low risk from incomplete facts is not authoritative", () => {
  const db = createRiskDb();
  db.prepare(`
    UPDATE session_cache
    SET enrichment_json = NULL
    WHERE session_uri = 'card-1'
  `).run();
  const snapshot = getRiskFactsSnapshot(
    db,
    "vscode-local://desktop",
    "card-1",
  );
  assert.ok(snapshot);
  setCardRiskInDb(
    db,
    "card-1",
    "low",
    ["Tiny counts-only change"],
    "copilot",
    snapshot.digest,
  );

  const risk = readAuthoritativeRisk(db, "card-1");
  assert.equal(risk.status, "policy-unsafe");
  assert.equal(riskAutomationPolicy(risk).level, "high");
  assert.equal(riskAutomationPolicy(risk).current, false);
  db.close();
});
