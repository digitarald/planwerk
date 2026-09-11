import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import Database from "better-sqlite3";

import { ensureCtoContinuitySchema } from "./cto-continuity-schema.ts";
import {
  CtoContinuityStore,
  type CtoApprovalBinding,
} from "./cto-continuity-store.ts";

function createStore(now: () => number = Date.now) {
  const db = new Database(":memory:");
  ensureCtoContinuitySchema(db);
  return { db, store: new CtoContinuityStore(db, now) };
}

function createConnectionPair() {
  fs.mkdirSync(path.join(process.cwd(), ".planwerk"), { recursive: true });
  const dbPath = path.join(
    process.cwd(),
    ".planwerk",
    `cto-continuity-test-${randomUUID()}.db`,
  );
  const first = new Database(dbPath);
  first.pragma("journal_mode = WAL");
  first.pragma("busy_timeout = 1000");
  ensureCtoContinuitySchema(first);
  const second = new Database(dbPath);
  second.pragma("busy_timeout = 1000");
  return {
    first,
    second,
    close() {
      first.close();
      second.close();
      fs.rmSync(dbPath, { force: true });
      fs.rmSync(`${dbPath}-wal`, { force: true });
      fs.rmSync(`${dbPath}-shm`, { force: true });
    },
  };
}

function binding(
  overrides: Partial<CtoApprovalBinding> = {}
): CtoApprovalBinding {
  return {
    toolName: "override_phase",
    args: {
      reason: "Reviewed",
      targetPhase: "ship",
      cardId: "card-1",
    },
    cardId: "card-1",
    sdkSessionId: "sdk-1",
    riskLevel: "high",
    facts: { phase: "review", gateStatus: "passed" },
    ...overrides,
  };
}

test("continuity schema and session record are restart-safe", () => {
  const db = new Database(":memory:");
  ensureCtoContinuitySchema(db);
  ensureCtoContinuitySchema(db);
  const first = new CtoContinuityStore(db);
  first.setSession("sdk-1", "model-1");

  const afterRestart = new CtoContinuityStore(db);
  assert.deepEqual(afterRestart.getSession(), {
    sessionId: "sdk-1",
    modelId: "model-1",
  });
  assert.equal(afterRestart.clearSession("other"), false);
  assert.equal(afterRestart.clearSession("sdk-1"), true);
  assert.equal(afterRestart.getSession(), null);
  db.close();
});

test("legacy SDK session bindings migrate to explicit active lifecycle state", () => {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE cto_sdk_sessions (
      singleton_key TEXT PRIMARY KEY,
      sdk_session_id TEXT NOT NULL,
      model_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO cto_sdk_sessions VALUES (
      'primary', 'legacy-session', 'legacy-model', 'created', 'updated'
    );
  `);
  ensureCtoContinuitySchema(db);
  assert.deepEqual(
    new CtoContinuityStore(db).getSessionBinding(),
    {
      sessionId: "legacy-session",
      modelId: "legacy-model",
      lifecycleState: "active",
      deletionToken: null,
      deletionStartedAtMs: null,
    },
  );
  db.close();
});

test("lease rejects contention and permits recovery after expiry", () => {
  let now = 1_000;
  const { db, store } = createStore(() => now);

  assert.equal(store.acquireLease("primary", "owner-a", 100), true);
  assert.equal(store.acquireLease("primary", "owner-b", 100), false);
  assert.equal(store.renewLease("primary", "owner-b", 100), false);

  now = 1_101;
  assert.equal(store.acquireLease("primary", "owner-b", 100), true);
  assert.equal(store.releaseLease("primary", "owner-a"), false);
  assert.equal(store.releaseLease("primary", "owner-b"), true);
  db.close();
});

test("stale owners cannot restore or clear a replacement quarantine", () => {
  let now = 1_000;
  const { db, store } = createStore(() => now);
  store.setSession("sdk-1", "model-1");
  assert.equal(store.acquireLease("primary", "owner-a", 100), true);
  assert.equal(
    store.quarantineSessionForDeletion(
      "sdk-1",
      "primary",
      "owner-a",
      "token-a",
    ),
    true,
  );

  now = 1_101;
  assert.equal(store.acquireLease("primary", "owner-b", 100), true);
  assert.equal(
    store.quarantineSessionForDeletion(
      "sdk-1",
      "primary",
      "owner-b",
      "token-b",
    ),
    true,
  );
  assert.equal(
    store.restoreQuarantinedSession(
      "sdk-1",
      "token-a",
      "primary",
      "owner-a",
    ),
    false,
  );
  assert.equal(
    store.clearQuarantinedSession(
      "sdk-1",
      "token-a",
      "primary",
      "owner-a",
    ),
    false,
  );
  assert.equal(store.getSessionBinding()?.deletionToken, "token-b");
  db.close();
});

test("approvals are bound, expire, and cannot be replayed", () => {
  let now = 2_000;
  const { db, store } = createStore(() => now);
  const requested = store.requestApproval(
    binding(),
    "cto-agent",
    100,
    "tool-call-1"
  );

  assert.equal(requested.approval.status, "pending");
  assert.equal(
    store.decideApprovalWithCapability(
      requested.decisionCapability,
      "approved",
    )?.status,
    "approved"
  );
  assert.equal(
    store.consumeApproval(binding(), "tool-call-1")?.status,
    "consumed"
  );
  assert.equal(store.consumeApproval(binding(), "tool-call-2"), null);
  assert.equal(
    store.hasConsumedApproval(binding(), "tool-call-1"),
    true
  );
  assert.equal(
    store.hasConsumedApproval(
      binding({ facts: { phase: "build", gateStatus: "pending" } }),
      "tool-call-1"
    ),
    false
  );

  const stale = store.requestApproval(
    binding({ args: { cardId: "card-1", targetPhase: "build", reason: "x" } }),
    "cto-agent",
    10,
    "tool-call-stale"
  );
  now += 11;
  assert.equal(
    store.decideApprovalWithCapability(
      stale.decisionCapability,
      "approved",
    ),
    null
  );
  assert.equal(store.getApproval(stale.approval.approvalId)?.status, "expired");
  db.close();
});

test("another connection preserves live approval owners and recovers stale ones", () => {
  let now = 4_000;
  const databases = createConnectionPair();
  try {
    const owner = new CtoContinuityStore(
      databases.first,
      () => now,
      { ownerId: "boot-a", ownerLeaseTtlMs: 100 },
    );
    const pending = owner.requestApproval(
      binding(),
      "cto-agent",
      60_000,
      "pending-call",
    );
    const approved = owner.requestApproval(
      binding({ args: { cardId: "card-1", targetPhase: "build" } }),
      "cto-agent",
      60_000,
      "approved-call",
    );
    owner.decideApprovalWithCapability(
      approved.decisionCapability,
      "approved",
    );

    ensureCtoContinuitySchema(databases.second);
    const observer = new CtoContinuityStore(
      databases.second,
      () => now,
      { ownerId: "boot-b", ownerLeaseTtlMs: 100 },
    );
    assert.equal(
      observer.getApproval(pending.approval.approvalId)?.status,
      "pending",
    );
    assert.equal(
      observer.getApproval(approved.approval.approvalId)?.status,
      "approved",
    );

    now = 4_101;
    assert.equal(observer.listApprovals("expired").length, 2);
    assert.equal(
      observer.getApproval(pending.approval.approvalId)?.status,
      "expired",
    );
    assert.equal(
      observer.getApproval(approved.approval.approvalId)?.status,
      "expired",
    );
  } finally {
    databases.close();
  }
});

test("legacy unowned approvals migrate without startup mutation and fail closed on use", () => {
  const db = new Database(":memory:");
  ensureCtoContinuitySchema(db);
  db.exec(`
    DROP TABLE cto_action_approvals;
    CREATE TABLE cto_action_approvals (
      approval_id TEXT PRIMARY KEY,
      action_hash TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      card_id TEXT,
      sdk_session_id TEXT NOT NULL,
      risk_level TEXT NOT NULL,
      facts_json TEXT NOT NULL,
      requested_by TEXT NOT NULL,
      requested_tool_call_id TEXT,
      status TEXT NOT NULL,
      expires_at_ms INTEGER NOT NULL,
      created_at_ms INTEGER NOT NULL,
      decided_at_ms INTEGER,
      decided_by TEXT,
      consumed_at_ms INTEGER,
      consumed_tool_call_id TEXT
    );
    INSERT INTO cto_action_approvals (
      approval_id, action_hash, tool_name, sdk_session_id, risk_level,
      facts_json, requested_by, requested_tool_call_id, status,
      expires_at_ms, created_at_ms
    ) VALUES (
      'legacy-approval', 'hash', 'override_phase', 'sdk-legacy', 'high',
      '{}', 'cto-agent', 'legacy-call', 'pending', 999999, 1
    );
  `);

  ensureCtoContinuitySchema(db);
  assert.deepEqual(
    db.prepare(`
      SELECT status, owner_id
      FROM cto_action_approvals
      WHERE approval_id = 'legacy-approval'
    `).get(),
    { status: "pending", owner_id: null },
  );
  const store = new CtoContinuityStore(
    db,
    () => 100,
    { ownerId: "new-boot", ownerLeaseTtlMs: 100 },
  );
  assert.equal(store.getApproval("legacy-approval")?.status, "expired");
  db.close();
});

test("tool idempotency returns a persisted result after restart", () => {
  const { db, store } = createStore();
  const key = "cto-tool:v1:sdk-1:call-1";
  const args = { cardId: "card-1", gateType: "test" };

  assert.deepEqual(
    store.claimToolExecution(key, "trigger_gate", args, "owner-1", 100),
    { state: "claimed" }
  );
  store.completeToolExecution(
    key,
    "owner-1",
    { success: true, message: "started" }
  );

  const afterRestart = new CtoContinuityStore(db);
  assert.deepEqual(
    afterRestart.claimToolExecution(
      key,
      "trigger_gate",
      args,
      "owner-2",
      100
    ),
    {
      state: "completed",
      result: { message: "started", success: true },
    }
  );
  assert.throws(
    () => afterRestart.claimToolExecution(
      key, "trigger_gate",
      { cardId: "other", gateType: "test" },
      "owner-2", 100
    ),
    /different tool action/
  );
  db.close();
});

test("expired running claims require reconciliation and can become needs-human", () => {
  let now = 5_000;
  const { db, store } = createStore(() => now);
  const key = "cto-tool:v1:sdk-1:call-stale";
  const args = { cardId: "card-1", message: "deploy" };

  assert.deepEqual(
    store.claimToolExecution(key, "send_message", args, "owner-1", 100),
    { state: "claimed" }
  );
  now += 101;
  assert.deepEqual(
    store.claimToolExecution(key, "send_message", args, "owner-2", 100),
    {
      state: "recovery-required",
      previousOwnerId: "owner-1",
      startedAtMs: 5_000,
    }
  );
  const result = {
    success: false,
    message: "Ambiguous side effect; human review required",
  };
  store.markToolExecutionNeedsHuman(key, result);
  assert.deepEqual(
    store.claimToolExecution(key, "send_message", args, "owner-3", 100),
    { state: "needs-human", result }
  );
  db.close();
});

test("another connection preserves a live tool claim until lease expiry", () => {
  let now = 5_000;
  const databases = createConnectionPair();
  try {
    const first = new CtoContinuityStore(databases.first, () => now);
    const key = "cto-tool:v1:sdk-1:call-restart";
    const args = { cardId: "card-1", gateType: "test" };
    assert.equal(
      first.claimToolExecution(key, "trigger_gate", args, "owner-a", 100)
        .state,
      "claimed",
    );

    ensureCtoContinuitySchema(databases.second);
    const second = new CtoContinuityStore(databases.second, () => now);
    assert.deepEqual(
      second.claimToolExecution(
        key,
        "trigger_gate",
        args,
        "owner-b",
        100,
      ),
      { state: "in-progress", leaseExpiresAtMs: 5_100 },
    );

    now = 5_101;
    assert.deepEqual(
      second.claimToolExecution(
        key,
        "trigger_gate",
        args,
        "owner-b",
        100,
      ),
      {
        state: "recovery-required",
        previousOwnerId: "owner-a",
        startedAtMs: 5_000,
      },
    );
  } finally {
    databases.close();
  }
});

test("abandoned retryable failures can be claimed again", () => {
  const { db, store } = createStore();
  const key = "cto-tool:v1:sdk-1:call-retry";
  const args = { cardId: "card-1" };

  assert.equal(
    store.claimToolExecution(key, "assess_risk", args, "owner-1", 100).state,
    "claimed"
  );
  assert.equal(store.abandonToolExecution(key, "owner-1"), true);
  assert.equal(
    store.claimToolExecution(key, "assess_risk", args, "owner-2", 100).state,
    "claimed"
  );
  db.close();
});

function createLegacyToolExecutionsTable(db: Database.Database, name: string) {
  db.exec(`
    CREATE TABLE ${name} (
      idempotency_key TEXT PRIMARY KEY,
      tool_name TEXT NOT NULL,
      action_hash TEXT NOT NULL,
      status TEXT NOT NULL,
      result_json TEXT,
      lease_expires_at_ms INTEGER NOT NULL,
      started_at_ms INTEGER NOT NULL,
      completed_at_ms INTEGER
    )
  `);
}

test("tool execution migration rolls back atomically when copying fails", () => {
  const db = new Database(":memory:");
  ensureCtoContinuitySchema(db);
  db.exec("DROP TABLE cto_tool_executions");
  createLegacyToolExecutionsTable(db, "cto_tool_executions");
  db.prepare(`
    INSERT INTO cto_tool_executions VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "bad-copy",
    "assess_risk",
    "hash",
    "completed",
    "{invalid-json",
    0,
    10,
    11,
  );

  assert.throws(() => ensureCtoContinuitySchema(db), /CHECK constraint/);
  assert.equal(
    (db.prepare(`
      SELECT COUNT(*) AS count FROM cto_tool_executions
    `).get() as { count: number }).count,
    1,
  );
  assert.equal(
    (db.prepare(`
      SELECT COUNT(*) AS count FROM sqlite_master
      WHERE type = 'table' AND name IN (
        'cto_tool_executions_legacy',
        'cto_tool_executions_migrating'
      )
    `).get() as { count: number }).count,
    0,
  );

  db.prepare(`
    UPDATE cto_tool_executions SET result_json = '{"success":true}'
  `).run();
  ensureCtoContinuitySchema(db);
  assert.equal(
    (db.prepare(`
      SELECT status FROM cto_tool_executions
      WHERE idempotency_key = 'bad-copy'
    `).get() as { status: string }).status,
    "completed",
  );
  db.close();
});

test("startup merges active and stranded legacy execution history", () => {
  const db = new Database(":memory:");
  ensureCtoContinuitySchema(db);
  db.prepare(`
    INSERT INTO cto_tool_executions (
      idempotency_key, tool_name, action_hash, status, result_json,
      owner_id, lease_expires_at_ms, attempt_count, started_at_ms,
      updated_at_ms, completed_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "duplicate",
    "send_message",
    "hash",
    "needs-human",
    '{"success":false,"message":"ambiguous"}',
    "owner",
    0,
    1,
    10,
    10,
    null,
  );
  createLegacyToolExecutionsTable(db, "cto_tool_executions_legacy");
  const insertLegacy = db.prepare(`
    INSERT INTO cto_tool_executions_legacy VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insertLegacy.run(
    "duplicate",
    "send_message",
    "hash",
    "completed",
    '{"success":true,"message":"done"}',
    0,
    10,
    11,
  );
  insertLegacy.run(
    "legacy-running",
    "trigger_gate",
    "hash-2",
    "running",
    null,
    50,
    12,
    null,
  );

  ensureCtoContinuitySchema(db);

  const rows = db.prepare(`
    SELECT idempotency_key, status, result_json
    FROM cto_tool_executions ORDER BY idempotency_key
  `).all() as Array<{
    idempotency_key: string;
    status: string;
    result_json: string;
  }>;
  assert.deepEqual(
    rows.map(({ idempotency_key, status }) => ({ idempotency_key, status })),
    [
      { idempotency_key: "duplicate", status: "completed" },
      { idempotency_key: "legacy-running", status: "needs-human" },
    ],
  );
  assert.deepEqual(JSON.parse(rows[0].result_json), {
    success: true,
    message: "done",
  });
  assert.match(JSON.parse(rows[1].result_json).message, /ambiguous/);
  assert.equal(
    (db.prepare(`
      SELECT COUNT(*) AS count FROM sqlite_master
      WHERE type = 'table' AND name = 'cto_tool_executions_legacy'
    `).get() as { count: number }).count,
    0,
  );
  assert.equal(
    (db.prepare(`
      SELECT COUNT(*) AS count FROM sqlite_master
      WHERE type = 'index'
        AND name = 'idx_cto_tool_executions_status_lease'
    `).get() as { count: number }).count,
    1,
  );
  db.close();
});
