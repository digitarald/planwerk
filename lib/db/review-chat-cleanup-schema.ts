import type Database from "better-sqlite3";

import { runSchemaMigration } from "./schema-migration.ts";

const CLEANUP_TABLE = "review_chat_cleanups";
const MIGRATING_CLEANUP_TABLE = "review_chat_cleanups_migrating";
const UNKNOWN_HOST_ERROR =
  "Quarantined: originating AHP host cannot be recovered.";

interface CleanupRow {
  host_url: string | null;
  chat_uri: string;
  turn_id: string | null;
  review_run_id: number;
  status: string;
  error: string | null;
  dispatch_diagnostic: string | null;
  blocks_review_start: number;
  attempts: number;
  last_attempt_at: string | null;
  claim_owner: string | null;
  lease_expires_at_ms: number | null;
  created_at: string;
  updated_at: string;
}

function tableExists(db: Database.Database, tableName: string): boolean {
  return Boolean(db.prepare(`
    SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?
  `).get(tableName));
}

function tableColumns(
  db: Database.Database,
  tableName: string,
): Set<string> {
  return new Set(
    (db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{
      name: string;
    }>).map(({ name }) => name),
  );
}

function createCleanupTable(
  db: Database.Database,
  tableName: string,
): void {
  db.exec(`
    CREATE TABLE ${tableName} (
      host_url TEXT,
      chat_uri TEXT NOT NULL,
      turn_id TEXT,
      review_run_id INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (
        status IN (
          'pending', 'in_progress', 'completed', 'error', 'quarantined'
        )
      ),
      error TEXT,
      dispatch_diagnostic TEXT,
      blocks_review_start INTEGER NOT NULL DEFAULT 0 CHECK (
        blocks_review_start IN (0, 1)
      ),
      attempts INTEGER NOT NULL DEFAULT 0,
      last_attempt_at TEXT,
      claim_owner TEXT,
      lease_expires_at_ms INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (host_url, chat_uri),
      CHECK (status = 'quarantined' OR host_url IS NOT NULL)
    );
  `);
}

function createCleanupIndexes(db: Database.Database): void {
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_review_chat_cleanups_retry
      ON review_chat_cleanups(
        host_url, status, attempts, lease_expires_at_ms
      );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_review_chat_cleanups_quarantined
      ON review_chat_cleanups(chat_uri)
      WHERE host_url IS NULL;
  `);
}

export function normalizeReviewChatCleanupHostUrl(hostUrl: string): string {
  return new URL(hostUrl).href;
}

function readCleanupRows(
  db: Database.Database,
  tableName: string,
): CleanupRow[] {
  const columns = tableColumns(db, tableName);
  const select = (column: string, fallback: string) =>
    columns.has(column) ? column : `${fallback} AS ${column}`;
  return db.prepare(`
    SELECT
      ${select("host_url", "NULL")},
      chat_uri,
      ${select("turn_id", "NULL")},
      review_run_id,
      ${select("status", "'pending'")},
      ${select("error", "NULL")},
      ${select("dispatch_diagnostic", "NULL")},
      ${select("blocks_review_start", "0")},
      ${select("attempts", "0")},
      ${select("last_attempt_at", "NULL")},
      ${select("claim_owner", "NULL")},
      ${select("lease_expires_at_ms", "NULL")},
      ${select("created_at", "datetime('now')")},
      ${select("updated_at", "datetime('now')")}
    FROM ${tableName}
  `).all() as CleanupRow[];
}

function migrateCleanupTable(db: Database.Database): void {
  runSchemaMigration(db, () => {
    const rows = readCleanupRows(db, CLEANUP_TABLE);
    db.exec(`DROP TABLE IF EXISTS ${MIGRATING_CLEANUP_TABLE}`);
    createCleanupTable(db, MIGRATING_CLEANUP_TABLE);
    const insert = db.prepare(`
      INSERT INTO ${MIGRATING_CLEANUP_TABLE} (
        host_url, chat_uri, turn_id, review_run_id, status, error,
        dispatch_diagnostic, blocks_review_start, attempts,
        last_attempt_at, claim_owner, lease_expires_at_ms,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const row of rows) {
      let hostUrl: string | null = null;
      if (row.host_url) {
        try {
          hostUrl = normalizeReviewChatCleanupHostUrl(row.host_url);
        } catch {
          hostUrl = null;
        }
      }
      const quarantined = hostUrl === null;
      insert.run(
        hostUrl,
        row.chat_uri,
        row.turn_id,
        row.review_run_id,
        quarantined ? "quarantined" : row.status,
        quarantined
          ? row.error
            ? `${row.error} ${UNKNOWN_HOST_ERROR}`
            : UNKNOWN_HOST_ERROR
          : row.error,
        row.dispatch_diagnostic,
        row.blocks_review_start,
        row.attempts,
        row.last_attempt_at,
        quarantined ? null : row.claim_owner,
        quarantined ? null : row.lease_expires_at_ms,
        row.created_at,
        row.updated_at,
      );
    }
    db.exec(`
      DROP TABLE ${CLEANUP_TABLE};
      ALTER TABLE ${MIGRATING_CLEANUP_TABLE} RENAME TO ${CLEANUP_TABLE};
    `);
    createCleanupIndexes(db);
  });
}

function ensureReviewChatCleanupSchemaLocked(
  db: Database.Database,
): void {
  if (!tableExists(db, CLEANUP_TABLE)) {
    createCleanupTable(db, CLEANUP_TABLE);
    createCleanupIndexes(db);
  } else {
    const columns = tableColumns(db, CLEANUP_TABLE);
    const tableSql = (db.prepare(`
      SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?
    `).get(CLEANUP_TABLE) as { sql?: string } | undefined)?.sql ?? "";
    const hasHostIdentity =
      columns.has("host_url")
      && /PRIMARY\s+KEY\s*\(\s*host_url\s*,\s*chat_uri\s*\)/i.test(tableSql)
      && tableSql.includes("'quarantined'");
    if (!hasHostIdentity) {
      migrateCleanupTable(db);
    } else {
      db.exec(`DROP TABLE IF EXISTS ${MIGRATING_CLEANUP_TABLE}`);
      if (!columns.has("turn_id")) {
        db.exec(`ALTER TABLE ${CLEANUP_TABLE} ADD COLUMN turn_id TEXT`);
      }
      if (!columns.has("dispatch_diagnostic")) {
        db.exec(
          `ALTER TABLE ${CLEANUP_TABLE} ADD COLUMN dispatch_diagnostic TEXT`,
        );
      }
      if (!columns.has("blocks_review_start")) {
        db.exec(`
          ALTER TABLE ${CLEANUP_TABLE}
          ADD COLUMN blocks_review_start INTEGER NOT NULL DEFAULT 0
          CHECK (blocks_review_start IN (0, 1))
        `);
      }
      createCleanupIndexes(db);
    }
  }

  db.prepare(`
    INSERT OR IGNORE INTO review_chat_cleanups (
      host_url, chat_uri, review_run_id, status, error, attempts,
      last_attempt_at
    )
    SELECT
      NULL,
      chat_uri,
      id,
      'quarantined',
      CASE
        WHEN chat_cleanup_error IS NULL THEN ?
        ELSE chat_cleanup_error || ' ' || ?
      END,
      chat_cleanup_attempts,
      chat_cleanup_last_attempt_at
    FROM review_runs
    WHERE chat_uri IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM review_chat_cleanups cleanup
        WHERE cleanup.chat_uri = review_runs.chat_uri
      )
      AND (
        chat_cleanup_status IS NOT NULL
        OR status IN (
          'passed', 'failed', 'cancelled', 'ambiguous', 'escalated'
        )
      )
  `).run(UNKNOWN_HOST_ERROR, UNKNOWN_HOST_ERROR);
}

export function ensureReviewChatCleanupSchema(
  db: Database.Database,
): void {
  runSchemaMigration(db, () => ensureReviewChatCleanupSchemaLocked(db));
}
