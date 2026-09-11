import type Database from "better-sqlite3";

import { runSchemaMigration } from "./schema-migration.ts";

const TOOL_EXECUTIONS_TABLE = "cto_tool_executions";
const LEGACY_TOOL_EXECUTIONS_TABLE = "cto_tool_executions_legacy";
const MIGRATING_TOOL_EXECUTIONS_TABLE = "cto_tool_executions_migrating";

function tableExists(db: Database.Database, name: string): boolean {
  return Boolean(db.prepare(`
    SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?
  `).get(name));
}

function tableColumns(
  db: Database.Database,
  name: string,
): Set<string> {
  return new Set(
    (db.prepare(`PRAGMA table_info(${name})`).all() as Array<{ name: string }>)
      .map(({ name: columnName }) => columnName),
  );
}

function createToolExecutionsTable(
  db: Database.Database,
  tableName: string,
): void {
  db.exec(`
    CREATE TABLE ${tableName} (
      idempotency_key TEXT PRIMARY KEY,
      tool_name TEXT NOT NULL,
      action_hash TEXT NOT NULL,
      status TEXT NOT NULL CHECK (
        status IN ('running', 'completed', 'needs-human')
      ),
      result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
      owner_id TEXT NOT NULL,
      lease_expires_at_ms INTEGER NOT NULL,
      attempt_count INTEGER NOT NULL DEFAULT 1,
      started_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      completed_at_ms INTEGER
    )
  `);
}

function copyToolExecutions(
  db: Database.Database,
  sourceTable: string,
): void {
  const columns = tableColumns(db, sourceTable);
  const hasOwner = columns.has("owner_id");
  const hasAttemptCount = columns.has("attempt_count");
  const hasUpdatedAt = columns.has("updated_at_ms");
  const statusExpression = columns.has("status")
    ? "CASE status WHEN 'completed' THEN 'completed' WHEN 'needs-human' THEN 'needs-human' ELSE 'needs-human' END"
    : "'needs-human'";
  const resultExpression = columns.has("result_json")
    ? `CASE
        WHEN status = 'completed' THEN result_json
        WHEN status = 'needs-human' AND result_json IS NOT NULL
          THEN result_json
        ELSE json_object(
          'success', 0,
          'message',
          'Execution state is ambiguous after server restart; human review is required.'
        )
      END`
    : `json_object(
        'success', 0,
        'message',
        'Execution state is ambiguous after server restart; human review is required.'
      )`;

  db.exec(`
    INSERT INTO ${MIGRATING_TOOL_EXECUTIONS_TABLE} (
      idempotency_key, tool_name, action_hash, status, result_json,
      owner_id, lease_expires_at_ms, attempt_count, started_at_ms,
      updated_at_ms, completed_at_ms
    )
    SELECT
      idempotency_key, tool_name, action_hash,
      ${statusExpression},
      ${resultExpression},
      ${hasOwner ? "owner_id" : "'restart-recovery'"},
      ${hasOwner ? "lease_expires_at_ms" : "0"},
      ${hasAttemptCount ? "attempt_count" : "1"},
      started_at_ms,
      ${hasUpdatedAt ? "updated_at_ms" : "COALESCE(completed_at_ms, started_at_ms)"},
      completed_at_ms
    FROM ${sourceTable}
    WHERE true
    ON CONFLICT(idempotency_key) DO UPDATE SET
      tool_name = excluded.tool_name,
      action_hash = excluded.action_hash,
      status = excluded.status,
      result_json = excluded.result_json,
      owner_id = excluded.owner_id,
      lease_expires_at_ms = excluded.lease_expires_at_ms,
      attempt_count = excluded.attempt_count,
      started_at_ms = excluded.started_at_ms,
      updated_at_ms = excluded.updated_at_ms,
      completed_at_ms = excluded.completed_at_ms
    WHERE ${MIGRATING_TOOL_EXECUTIONS_TABLE}.status != 'completed'
      AND excluded.status = 'completed'
  `);
}

function ensureToolExecutionsSchema(db: Database.Database): void {
  const activeExists = tableExists(db, TOOL_EXECUTIONS_TABLE);
  const legacyExists = tableExists(db, LEGACY_TOOL_EXECUTIONS_TABLE);
  const activeColumns = activeExists
    ? tableColumns(db, TOOL_EXECUTIONS_TABLE)
    : new Set<string>();
  const activeSql = activeExists
    ? ((db.prepare(`
        SELECT sql FROM sqlite_master
        WHERE type = 'table' AND name = ?
      `).get(TOOL_EXECUTIONS_TABLE) as { sql?: string } | undefined)?.sql ?? "")
    : "";
  const activeIsCurrent =
    activeColumns.has("owner_id") && activeSql.includes("'needs-human'");

  if (activeIsCurrent && !legacyExists) {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_cto_tool_executions_status_lease
        ON cto_tool_executions(status, lease_expires_at_ms)
    `);
    return;
  }

  runSchemaMigration(db, () => {
    db.exec(`DROP TABLE IF EXISTS ${MIGRATING_TOOL_EXECUTIONS_TABLE}`);
    createToolExecutionsTable(db, MIGRATING_TOOL_EXECUTIONS_TABLE);
    if (activeExists) copyToolExecutions(db, TOOL_EXECUTIONS_TABLE);
    if (legacyExists) copyToolExecutions(db, LEGACY_TOOL_EXECUTIONS_TABLE);
    if (activeExists) db.exec(`DROP TABLE ${TOOL_EXECUTIONS_TABLE}`);
    if (legacyExists) db.exec(`DROP TABLE ${LEGACY_TOOL_EXECUTIONS_TABLE}`);
    db.exec(`
      ALTER TABLE ${MIGRATING_TOOL_EXECUTIONS_TABLE}
        RENAME TO ${TOOL_EXECUTIONS_TABLE};
      CREATE INDEX idx_cto_tool_executions_status_lease
        ON cto_tool_executions(status, lease_expires_at_ms);
    `);
  });
}

function ensureCtoContinuitySchemaLocked(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS cto_sdk_sessions (
      singleton_key TEXT PRIMARY KEY CHECK (singleton_key = 'primary'),
      sdk_session_id TEXT NOT NULL,
      model_id TEXT NOT NULL,
      lifecycle_state TEXT NOT NULL DEFAULT 'active' CHECK (
        lifecycle_state IN ('active', 'deleting')
      ),
      deletion_token TEXT,
      deletion_started_at_ms INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS cto_session_leases (
      resource_key TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      acquired_at_ms INTEGER NOT NULL,
      expires_at_ms INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS cto_process_owners (
      owner_id TEXT PRIMARY KEY,
      acquired_at_ms INTEGER NOT NULL,
      expires_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS cto_action_approvals (
      approval_id TEXT PRIMARY KEY,
      action_hash TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      card_id TEXT,
      sdk_session_id TEXT NOT NULL,
      risk_level TEXT NOT NULL,
      facts_json TEXT NOT NULL CHECK (json_valid(facts_json)),
      requested_by TEXT NOT NULL,
      owner_id TEXT,
      requested_tool_call_id TEXT NOT NULL,
      decision_capability_hash TEXT,
      status TEXT NOT NULL CHECK (
        status IN ('pending', 'approved', 'rejected', 'consumed', 'expired')
      ),
      expires_at_ms INTEGER NOT NULL,
      created_at_ms INTEGER NOT NULL,
      decided_at_ms INTEGER,
      decided_by TEXT,
      consumed_at_ms INTEGER,
      consumed_tool_call_id TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_cto_approvals_action
      ON cto_action_approvals(action_hash, status, expires_at_ms);
    CREATE INDEX IF NOT EXISTS idx_cto_approvals_status
      ON cto_action_approvals(status, expires_at_ms);

  `);

  const sessionColumns = db
    .prepare("PRAGMA table_info(cto_sdk_sessions)")
    .all() as Array<{ name: string }>;
  if (!sessionColumns.some((column) => column.name === "lifecycle_state")) {
    db.exec(`
      ALTER TABLE cto_sdk_sessions
      ADD COLUMN lifecycle_state TEXT NOT NULL DEFAULT 'active';
    `);
  }
  if (!sessionColumns.some((column) => column.name === "deletion_token")) {
    db.exec("ALTER TABLE cto_sdk_sessions ADD COLUMN deletion_token TEXT;");
  }
  if (!sessionColumns.some(
    (column) => column.name === "deletion_started_at_ms"
  )) {
    db.exec(`
      ALTER TABLE cto_sdk_sessions
      ADD COLUMN deletion_started_at_ms INTEGER;
    `);
  }

  const approvalColumns = db
    .prepare("PRAGMA table_info(cto_action_approvals)")
    .all() as Array<{ name: string }>;
  if (!approvalColumns.some(
    (column) => column.name === "requested_tool_call_id"
  )) {
    db.exec(`
      ALTER TABLE cto_action_approvals
      ADD COLUMN requested_tool_call_id TEXT;
    `);
  }
  if (!approvalColumns.some((column) => column.name === "owner_id")) {
    db.exec(`
      ALTER TABLE cto_action_approvals
      ADD COLUMN owner_id TEXT;
    `);
  }
  if (!approvalColumns.some(
    (column) => column.name === "decision_capability_hash"
  )) {
    db.exec(`
      ALTER TABLE cto_action_approvals
      ADD COLUMN decision_capability_hash TEXT;
    `);
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_cto_approvals_owner
      ON cto_action_approvals(owner_id, status, expires_at_ms);
    CREATE INDEX IF NOT EXISTS idx_cto_process_owners_expiry
      ON cto_process_owners(expires_at_ms);
  `);

  ensureToolExecutionsSchema(db);
}

export function ensureCtoContinuitySchema(db: Database.Database): void {
  runSchemaMigration(db, () => ensureCtoContinuitySchemaLocked(db));
}
