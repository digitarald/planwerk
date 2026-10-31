import type Database from "better-sqlite3";

import { runSchemaMigration, tableColumns } from "./schema-migration.ts";

const ADDITIVE_COLUMNS = [
  ["turn_id", "TEXT"],
  ["chat_uri", "TEXT"],
  ["chat_cleanup_status", "TEXT"],
  ["chat_cleanup_error", "TEXT"],
  ["chat_cleanup_attempts", "INTEGER NOT NULL DEFAULT 0"],
  ["chat_cleanup_last_attempt_at", "TEXT"],
  ["judgment_owner_id", "TEXT"],
  ["judgment_lease_expires_at_ms", "INTEGER"],
  ["start_owner_id", "TEXT"],
  ["start_lease_expires_at_ms", "INTEGER"],
  ["dispatch_host_url", "TEXT"],
  ["dispatch_chat_disposable", "INTEGER"],
  ["plan_source_json", "TEXT"],
  ["source_digest", "TEXT"],
] as const;

export function ensureReviewRunSchema(db: Database.Database): void {
  runSchemaMigration(db, () => {
    const columns = tableColumns(db, "review_runs");
    for (const [name, definition] of ADDITIVE_COLUMNS) {
      if (columns.has(name)) continue;
      db.exec(`ALTER TABLE review_runs ADD COLUMN ${name} ${definition}`);
      columns.add(name);
    }

    const duplicatePredicate = `
      candidate.status IN (
        'pending', 'dispatching', 'injected', 'extracting', 'ambiguous'
      )
      AND EXISTS (
        SELECT 1
        FROM review_runs AS newer
        WHERE newer.card_id = candidate.card_id
          AND newer.skill_id = candidate.skill_id
          AND newer.phase_transition = candidate.phase_transition
          AND newer.status IN (
            'pending', 'dispatching', 'injected', 'extracting', 'ambiguous'
          )
          AND newer.id > candidate.id
      )
    `;
    const gateRunsExist = Boolean(db.prepare(`
      SELECT 1 FROM sqlite_master
      WHERE type = 'table' AND name = 'gate_runs'
    `).get());
    if (gateRunsExist) {
      db.exec(`
        UPDATE gate_runs
        SET status = 'failed',
            output = 'Superseded duplicate active review claim.',
            completed_at = datetime('now')
        WHERE status = 'running'
          AND id IN (
            SELECT candidate.gate_run_id
            FROM review_runs AS candidate
            WHERE ${duplicatePredicate}
          );
      `);
    }

    db.exec(`
      UPDATE review_runs AS candidate
      SET status = 'cancelled',
          verdict_summary = COALESCE(
            verdict_summary,
            'Superseded while repairing duplicate active review claims.'
          ),
          judgment_owner_id = NULL,
          judgment_lease_expires_at_ms = NULL,
          start_owner_id = NULL,
          start_lease_expires_at_ms = NULL
      WHERE ${duplicatePredicate};

      DROP INDEX IF EXISTS idx_review_runs_active_identity;
      CREATE UNIQUE INDEX idx_review_runs_active_identity
      ON review_runs(card_id, skill_id, phase_transition)
      WHERE status IN (
        'pending', 'dispatching', 'injected', 'extracting', 'ambiguous'
      );
    `);
  });
}
