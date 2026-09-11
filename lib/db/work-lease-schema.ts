import type Database from "better-sqlite3";

import { runSchemaMigration, tableColumns } from "./schema-migration.ts";

export const WORK_LEASE_MS = 60_000;
export const ABANDONED_REVIEW_START_SUMMARY =
  "Abandoned before review prompt dispatch after the owner lease expired.";
export const AMBIGUOUS_REVIEW_DISPATCH_SUMMARY =
  "Review prompt dispatch was interrupted before confirmation; human reconciliation is required.";

function tableExists(db: Database.Database, tableName: string): boolean {
  return Boolean(db.prepare(`
    SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?
  `).get(tableName));
}

function addColumns(
  db: Database.Database,
  tableName: string,
  columns: ReadonlyArray<readonly [string, string]>,
): void {
  if (!tableExists(db, tableName)) return;
  const existing = tableColumns(db, tableName);
  for (const [name, definition] of columns) {
    if (existing.has(name)) continue;
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${name} ${definition}`);
    existing.add(name);
  }
}

export function ensureWorkLeaseSchema(db: Database.Database): void {
  runSchemaMigration(db, () => {
    addColumns(db, "gate_runs", [
      ["owner_id", "TEXT"],
      ["lease_expires_at_ms", "INTEGER"],
    ]);
    addColumns(db, "review_runs", [
      ["start_owner_id", "TEXT"],
      ["start_lease_expires_at_ms", "INTEGER"],
    ]);
    addColumns(db, "coherence_conflicts", [
      ["review_owner_id", "TEXT"],
      ["review_lease_expires_at_ms", "INTEGER"],
    ]);

    if (tableExists(db, "gate_runs")) {
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_gate_runs_status_lease
          ON gate_runs(status, lease_expires_at_ms)
      `);
    }
    if (tableExists(db, "review_runs")) {
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_review_runs_start_lease
          ON review_runs(status, start_lease_expires_at_ms)
      `);
    }
    if (tableExists(db, "coherence_conflicts")) {
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_coherence_review_lease
          ON coherence_conflicts(status, review_lease_expires_at_ms)
      `);
    }
  });
}

export interface WorkRecoveryResult {
  reviewStarts: number;
  gates: number;
  coherenceReviews: number;
}

/**
 * Recover only work whose lease has expired. BEGIN IMMEDIATE serializes the
 * expiry check with owner renewals, so a rolling worker cannot reset live work.
 */
export function recoverExpiredWork(
  db: Database.Database,
  now = Date.now(),
): WorkRecoveryResult {
  const recover = db.transaction((): WorkRecoveryResult => {
    const expiredDispatches = db.prepare(`
      SELECT id, chat_uri, turn_id, dispatch_host_url,
        dispatch_chat_disposable
      FROM review_runs
      WHERE status = 'dispatching'
        AND COALESCE(start_lease_expires_at_ms, 0) <= ?
    `).all(now) as Array<{
      id: number;
      chat_uri: string | null;
      turn_id: string | null;
      dispatch_host_url: string | null;
      dispatch_chat_disposable: number | null;
    }>;

    const linkedGates = db.prepare(`
      UPDATE gate_runs
      SET status = 'failed',
          output = ?,
          completed_at = datetime('now'),
          owner_id = NULL,
          lease_expires_at_ms = NULL
      WHERE status = 'running'
        AND id IN (
          SELECT gate_run_id
          FROM review_runs
          WHERE status = 'pending'
            AND COALESCE(start_lease_expires_at_ms, 0) <= ?
            AND gate_run_id IS NOT NULL
        )
    `).run(ABANDONED_REVIEW_START_SUMMARY, now);

    const dispatchingGates = db.prepare(`
      UPDATE gate_runs
      SET status = 'failed',
          output = ?,
          completed_at = datetime('now'),
          owner_id = NULL,
          lease_expires_at_ms = NULL
      WHERE status = 'running'
        AND id IN (
          SELECT gate_run_id
          FROM review_runs
          WHERE status = 'dispatching'
            AND COALESCE(start_lease_expires_at_ms, 0) <= ?
            AND gate_run_id IS NOT NULL
        )
    `).run(AMBIGUOUS_REVIEW_DISPATCH_SUMMARY, now);

    const reviewStarts = db.prepare(`
      UPDATE review_runs
      SET status = 'failed',
          verdict_summary = COALESCE(verdict_summary, ?),
          start_owner_id = NULL,
          start_lease_expires_at_ms = NULL
      WHERE status = 'pending'
        AND COALESCE(start_lease_expires_at_ms, 0) <= ?
    `).run(ABANDONED_REVIEW_START_SUMMARY, now);

    const dispatchingReviews = db.prepare(`
      UPDATE review_runs
      SET status = 'ambiguous',
          verdict_summary = COALESCE(verdict_summary, ?),
          start_owner_id = NULL,
          start_lease_expires_at_ms = NULL
      WHERE status = 'dispatching'
        AND COALESCE(start_lease_expires_at_ms, 0) <= ?
    `).run(AMBIGUOUS_REVIEW_DISPATCH_SUMMARY, now);

    if (tableExists(db, "review_chat_cleanups")) {
      const queueCleanup = db.prepare(`
        INSERT INTO review_chat_cleanups (
          host_url, chat_uri, turn_id, review_run_id, status, error,
          dispatch_diagnostic, blocks_review_start, attempts
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0)
        ON CONFLICT DO NOTHING
      `);
      for (const dispatch of expiredDispatches) {
        if (!dispatch.chat_uri) continue;
        const disposable = dispatch.dispatch_chat_disposable === 1
          && dispatch.dispatch_host_url !== null;
        queueCleanup.run(
          dispatch.dispatch_host_url,
          dispatch.chat_uri,
          dispatch.turn_id,
          dispatch.id,
          disposable ? "pending" : "quarantined",
          disposable ? null : AMBIGUOUS_REVIEW_DISPATCH_SUMMARY,
          AMBIGUOUS_REVIEW_DISPATCH_SUMMARY,
        );
      }
    }

    const gates = db.prepare(`
      UPDATE gate_runs
      SET status = 'failed',
          output = 'Abandoned after the owner lease expired; re-run this gate.',
          completed_at = datetime('now'),
          owner_id = NULL,
          lease_expires_at_ms = NULL
      WHERE status = 'running'
        AND COALESCE(lease_expires_at_ms, 0) <= ?
        AND NOT EXISTS (
          SELECT 1
          FROM review_runs
          WHERE review_runs.gate_run_id = gate_runs.id
            AND review_runs.status IN (
              'dispatching', 'injected', 'extracting', 'ambiguous'
            )
        )
    `).run(now);

    const coherenceReviews = db.prepare(`
      UPDATE coherence_conflicts
      SET status = 'detected',
          review_owner_id = NULL,
          review_lease_expires_at_ms = NULL,
          updated_at = datetime('now')
      WHERE status = 'reviewing'
        AND COALESCE(review_lease_expires_at_ms, 0) <= ?
    `).run(now);

    return {
      reviewStarts: reviewStarts.changes + dispatchingReviews.changes,
      gates:
        gates.changes + linkedGates.changes + dispatchingGates.changes,
      coherenceReviews: coherenceReviews.changes,
    };
  });
  return recover.immediate();
}
