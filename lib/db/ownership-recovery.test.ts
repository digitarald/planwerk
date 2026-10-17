import assert from "node:assert/strict";
import { test } from "node:test";
import Database from "better-sqlite3";

import type { AHPSessionSummary } from "../ahp/types.ts";
import {
  claimSessionOwnership, ensureSessionOwnershipSchema, getSessionOwnership,
  isSessionOwnedByHost, ownershipHostChoice,
} from "./session-ownership.ts";
import { recoverSessionOwnership } from "./ownership-recovery.ts";

const uri = "copilotcli:/same-uri";
const owner = "ws://user:secret@127.0.0.1:8080/private/path?token=owner-token#secret";
const other = "ws://127.0.0.1:8081/other-secret?token=other-token";
const third = "ws://127.0.0.1:8082/third";
const summary: AHPSessionSummary = {
  resource: uri, provider: "copilotcli", title: "Selected catalog", status: 1,
  createdAt: "2026-10-17T00:00:00Z", modifiedAt: "2026-10-17T01:00:00Z",
};
function row(db: Database.Database, sql: string): Record<string, unknown> {
  return db.prepare(sql).get() as Record<string, unknown>;
}
function fixture() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE session_cache (session_uri TEXT PRIMARY KEY, host_url TEXT NOT NULL,
      summary_json TEXT NOT NULL, enrichment_json TEXT, updated_at TEXT);
    CREATE TABLE card_phases (card_id TEXT PRIMARY KEY, phase TEXT);
    CREATE TABLE gate_runs (id INTEGER PRIMARY KEY, card_id TEXT, status TEXT,
      output TEXT, changeset_ref TEXT);
    CREATE TABLE review_runs (id INTEGER PRIMARY KEY, card_id TEXT, status TEXT,
      verdict_summary TEXT, findings_json TEXT, changeset_ref TEXT);
    CREATE TABLE card_risk (card_id TEXT PRIMARY KEY, risk_digest TEXT);
    CREATE TABLE heartbeat_log (card_id TEXT, detail TEXT);
    CREATE TABLE coherence_conflicts (id INTEGER PRIMARY KEY, card_a TEXT, card_b TEXT,
      host_url TEXT, status TEXT, signature TEXT, verdict_summary TEXT,
      resolved_at TEXT, resolved_by TEXT, activation_key TEXT,
      dismissed_signature TEXT);
    CREATE TABLE cto_tool_executions (status TEXT);
    CREATE TABLE cto_action_approvals (card_id TEXT, status TEXT);
    CREATE TABLE review_chat_cleanups (review_run_id INTEGER, status TEXT);
  `);
  db.prepare("INSERT INTO session_cache VALUES (?, ?, ?, ?, 'before')")
    .run(uri, owner, JSON.stringify({ ...summary, title: "Old title", _planwerkRiskFacts: { sourceRevision: "old" } }),
      JSON.stringify({ planContentHash: "plan:identical", changesetVerified: true }));
  db.prepare("INSERT INTO card_phases VALUES (?, 'plan')").run(uri);
  db.prepare("INSERT INTO gate_runs VALUES (1, ?, 'passed', 'original output', 'plan:identical')").run(uri);
  db.prepare("INSERT INTO review_runs VALUES (1, ?, 'passed', 'original verdict', '[1]', 'plan:identical')").run(uri);
  db.prepare("INSERT INTO card_risk VALUES (?, 'old-risk')").run(uri);
  db.prepare("INSERT INTO heartbeat_log VALUES (?, 'prior audit')").run(uri);
  db.prepare(`INSERT INTO coherence_conflicts
    (id, card_a, card_b, host_url, status, signature, verdict_summary, resolved_at, resolved_by, activation_key)
    VALUES
    (1, ?, 'peer', ?, 'coherent', 'old-signature', 'historical verdict', 'old', 'reviewer', 'old')`)
    .run(uri, owner);
  db.prepare("INSERT INTO cto_action_approvals VALUES (?, 'approved')").run(uri);
  ensureSessionOwnershipSchema(db);
  assert.equal(claimSessionOwnership(db, uri, other), false);
  return db;
}
function recover(db: Database.Database, hostUrl = other) {
  return recoverSessionOwnership(db, {
    sessionUri: uri, hostId: ownershipHostChoice(hostUrl).hostId,
    expectedRevision: getSessionOwnership(db, uri)!.revision, confirm: true, summary,
  });
}

test("diagnostics redact URL credentials, tokens, paths and fragments", () => {
  const db = fixture();
  try {
    const diagnostic = getSessionOwnership(db, uri)!;
    assert.equal(diagnostic.quarantined, true);
    assert.equal(diagnostic.owner.label, "ws://127.0.0.1:8080");
    assert.equal(diagnostic.conflictingHost?.label, "ws://127.0.0.1:8081");
    assert.equal(diagnostic.hosts.length, 2);
    const json = JSON.stringify(diagnostic);
    for (const secret of ["secret", "token", "private", "user:", "other-secret"]) {
      assert.equal(json.includes(secret), false, secret);
    }
    assert.equal(ownershipHostChoice("not a URL secret").label, "Configured host");
  } finally { db.close(); }
});

test("atomic recovery preserves phase/history and revokes gates, same-hash plan, risk, reviews and coherence", () => {
  const db = fixture();
  try {
    const before = getSessionOwnership(db, uri)!;
    const result = recover(db);
    assert.equal(result.success, true);
    if (!result.success) return;
    assert.equal(result.ownership.revision, before.revision + 1);
    assert.equal(result.ownership.quarantined, false);
    assert.equal(isSessionOwnedByHost(db, uri, other), true);
    assert.equal(isSessionOwnedByHost(db, uri, owner), false);
    const cached = db.prepare("SELECT * FROM session_cache").get() as Record<string, unknown>;
    assert.equal(cached.host_url, other);
    assert.equal(cached.enrichment_json, null);
    assert.deepEqual(JSON.parse(cached.summary_json as string), summary);
    assert.equal(typeof cached.cache_token, "string");
    assert.deepEqual(db.prepare("SELECT * FROM card_phases").get(), { card_id: uri, phase: "plan" });
    assert.deepEqual(db.prepare("SELECT * FROM heartbeat_log").get(), { card_id: uri, detail: "prior audit" });
    assert.equal(row(db, "SELECT count(*) AS n FROM card_risk").n, 0);
    assert.deepEqual(db.prepare("SELECT status, output, changeset_ref FROM gate_runs").get(), {
      status: "failed", output: "original output", changeset_ref: "plan:identical",
    });
    assert.equal(row(db, "SELECT count(*) AS n FROM gate_runs WHERE status = 'passed' AND changeset_ref = 'plan:identical'").n, 0);
    assert.deepEqual(db.prepare("SELECT status, verdict_summary, findings_json FROM review_runs").get(), {
      status: "cancelled", verdict_summary: "original verdict", findings_json: "[1]",
    });
    assert.deepEqual(db.prepare("SELECT status, host_url, verdict_summary FROM coherence_conflicts").get(), {
      status: "detected", host_url: null, verdict_summary: "historical verdict",
    });
    assert.equal(row(db, "SELECT status FROM cto_action_approvals").status, "expired");
    const audit = db.prepare("SELECT * FROM session_ownership_recovery_audit").get() as Record<string, unknown>;
    assert.equal(audit.previous_host_url, owner);
    assert.equal(audit.selected_host_url, other);
    const original = JSON.parse(audit.invalidated_authority_json as string);
    assert.equal(original.gates[0].status, "passed");
    assert.equal(original.reviews[0].status, "passed");
    assert.equal(original.risk[0].risk_digest, "old-risk");
    assert.equal(original.coherence[0].status, "coherent");
  } finally { db.close(); }
});

test("either known host can be selected; rejected reconnects cannot overwrite or requarantine; third host quarantines", () => {
  for (const selected of [owner, other]) {
    const db = fixture();
    try {
      assert.equal(recover(db, selected).success, true);
      const revision = getSessionOwnership(db, uri)!.revision;
      const rejected = selected === owner ? other : owner;
      assert.equal(claimSessionOwnership(db, uri, selected), true);
      assert.equal(claimSessionOwnership(db, uri, rejected), false);
      assert.equal(getSessionOwnership(db, uri)!.revision, revision);
      assert.equal(getSessionOwnership(db, uri)!.quarantined, false);
      assert.equal(claimSessionOwnership(db, uri, third), false);
      assert.equal(getSessionOwnership(db, uri)!.quarantined, true);
      assert.equal(getSessionOwnership(db, uri)!.hosts.length, 3);
      assert.equal(getSessionOwnership(db, uri)!.revision, revision + 1);
      // Explicitly choosing a previously rejected host is still allowed.
      assert.equal(recover(db, rejected).success, true);
      assert.equal(claimSessionOwnership(db, uri, rejected), true);
      assert.equal(claimSessionOwnership(db, uri, selected), false);
    } finally { db.close(); }
  }
});

test("same-host coherence can be reviewed again but never revives an old dismissal", () => {
  const db = fixture();
  try {
    claimSessionOwnership(db, "peer", owner);
    db.exec("UPDATE coherence_conflicts SET status = 'dismissed', dismissed_signature = signature");
    assert.equal(recover(db, owner).success, true);
    const conflict = row(db, "SELECT * FROM coherence_conflicts");
    assert.equal(conflict.host_url, owner);
    assert.equal(conflict.status, "detected");
    assert.equal(conflict.dismissed_signature, null);
    assert.notEqual(conflict.signature, "old-signature");
    assert.equal(conflict.verdict_summary, "historical verdict");
  } finally { db.close(); }
});

test("stale CAS, unconfirmed recovery, unknown choices and wrong catalog URI are read-only failures", () => {
  const db = fixture();
  try {
    const input = {
      sessionUri: uri, hostId: ownershipHostChoice(other).hostId,
      expectedRevision: getSessionOwnership(db, uri)!.revision, confirm: true, summary,
    };
    for (const [change, reason] of [
      [{ expectedRevision: input.expectedRevision - 1 }, "stale"],
      [{ confirm: false }, "confirmation-required"],
      [{ hostId: ownershipHostChoice(third).hostId }, "unknown-host"],
      [{ summary: { ...summary, resource: "different" } }, "catalog-missing"],
    ] as const) {
      assert.deepEqual(recoverSessionOwnership(db, { ...input, ...change }), { success: false, reason });
      assert.equal(getSessionOwnership(db, uri)!.quarantined, true);
      assert.equal(row(db, "SELECT status FROM gate_runs").status, "passed");
    }
    assert.equal(row(db, "SELECT count(*) AS n FROM session_ownership_recovery_audit").n, 0);
    assert.equal(recoverSessionOwnership(db, input).success, true);
    assert.deepEqual(recoverSessionOwnership(db, input), { success: false, reason: "stale" });
    assert.equal(row(db, "SELECT count(*) AS n FROM session_ownership_recovery_audit").n, 1);
  } finally { db.close(); }
});

test("active and ambiguous gate/review/CTO/coherence/cleanup work blocks instead of retargeting", () => {
  for (const sql of [
    "UPDATE gate_runs SET status = 'running'",
    "UPDATE gate_runs SET status = 'dispatching'",
    ...["pending", "dispatching", "injected", "extracting", "ambiguous", "running"]
      .map((status) => `UPDATE review_runs SET status = '${status}'`),
    "UPDATE coherence_conflicts SET status = 'reviewing'",
    "INSERT INTO cto_tool_executions VALUES ('running')",
    "INSERT INTO cto_tool_executions VALUES ('needs-human')",
    "INSERT INTO review_chat_cleanups VALUES (1, 'in_progress')",
  ]) {
    const db = fixture();
    try {
      db.exec(sql);
      assert.deepEqual(recover(db), { success: false, reason: "in-flight" }, sql);
      assert.equal(row(db, "SELECT host_url FROM session_cache").host_url, owner);
      assert.equal(getSessionOwnership(db, uri)!.quarantined, true);
      assert.equal(row(db, "SELECT count(*) AS n FROM session_ownership_recovery_audit").n, 0);
    } finally { db.close(); }
  }
});

test("audit or invalidation failure rolls back the ownership CAS and all mutations", () => {
  const db = fixture();
  try {
    db.exec(`CREATE TRIGGER refuse_recovery BEFORE UPDATE ON gate_runs
      BEGIN SELECT RAISE(ABORT, 'refuse'); END;`);
    const before = getSessionOwnership(db, uri);
    assert.throws(() => recover(db), /refuse/);
    assert.deepEqual(getSessionOwnership(db, uri), before);
    assert.equal(row(db, "SELECT host_url FROM session_cache").host_url, owner);
    assert.equal(row(db, "SELECT count(*) AS n FROM card_risk").n, 1);
    assert.equal(row(db, "SELECT count(*) AS n FROM session_ownership_recovery_audit").n, 0);
  } finally { db.close(); }
});

test("legacy quarantines migrate revisions and both choices without losing reservations", () => {
  const db = new Database(":memory:");
  try {
    db.exec(`
      CREATE TABLE session_cache (session_uri TEXT PRIMARY KEY, host_url TEXT);
      CREATE TABLE session_uri_ownership (
        session_uri TEXT PRIMARY KEY, host_url TEXT NOT NULL, quarantined INTEGER,
        conflicting_host_url TEXT, updated_at TEXT
      );
    `);
    db.prepare("INSERT INTO session_uri_ownership VALUES (?, ?, 1, ?, 'before')").run(uri, owner, other);
    assert.equal(getSessionOwnership(db, uri)!.revision, 1);
    assert.equal(getSessionOwnership(db, uri)!.hosts.length, 2);
    assert.equal(claimSessionOwnership(db, uri, owner), false);
  } finally { db.close(); }
});
