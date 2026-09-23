import "server-only";

import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { ensureCtoContinuitySchema } from "./cto-continuity-schema";
import { ensureCoordinatorModeSchema } from "./coordinator-mode-schema";
import { ensureSdkObservabilitySchema } from "./sdk-observability-schema";
import { ensureReviewChatCleanupSchema } from "./review-chat-cleanup-schema";
import { ensureCardRiskSchema } from "./card-risk-schema";
import { ensureReviewRunSchema } from "./review-run-schema";
import { ensureInboxSchema } from "./inbox-schema";
import { runSchemaMigration, tableColumns } from "./schema-migration";
import {
  ensureWorkLeaseSchema,
  recoverExpiredWork,
} from "./work-lease-schema";

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!db) {
    const dbPath = path.join(process.cwd(), ".planwerk", "planwerk.db");

    fs.mkdirSync(path.dirname(dbPath), { recursive: true });

    db = new Database(dbPath);
    db.pragma("busy_timeout = 5000");
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");

    db.exec(`
      CREATE TABLE IF NOT EXISTS card_phases (
        card_id TEXT PRIMARY KEY,
        phase TEXT NOT NULL DEFAULT 'define',
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS gate_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        card_id TEXT NOT NULL,
        from_phase TEXT NOT NULL,
        to_phase TEXT NOT NULL,
        gate_type TEXT NOT NULL,
        gate_name TEXT,
        status TEXT NOT NULL DEFAULT 'running',
        output TEXT,
        started_at TEXT NOT NULL DEFAULT (datetime('now')),
        completed_at TEXT,
        changeset_ref TEXT,
        owner_id TEXT,
        lease_expires_at_ms INTEGER,
        FOREIGN KEY (card_id) REFERENCES card_phases(card_id)
      );

      CREATE TABLE IF NOT EXISTS gate_configs (
        project_path TEXT NOT NULL,
        phase_transition TEXT NOT NULL,
        gate_type TEXT NOT NULL,
        command TEXT,
        required BOOLEAN NOT NULL DEFAULT 1,
        PRIMARY KEY (project_path, phase_transition, gate_type)
      );

      CREATE TABLE IF NOT EXISTS session_cache (
        session_uri TEXT PRIMARY KEY,
        host_url TEXT NOT NULL,
        summary_json TEXT NOT NULL,
        enrichment_json TEXT,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_gate_runs_card ON gate_runs(card_id);
      CREATE INDEX IF NOT EXISTS idx_gate_runs_status ON gate_runs(status);
      CREATE INDEX IF NOT EXISTS idx_session_cache_host ON session_cache(host_url);

      CREATE TABLE IF NOT EXISTS review_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        card_id TEXT NOT NULL,
        skill_id TEXT NOT NULL,
        phase_transition TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        iteration INTEGER NOT NULL DEFAULT 1,
        max_iterations INTEGER NOT NULL DEFAULT 2,
        prompt_injected_at TEXT,
        verdict_extracted_at TEXT,
        verdict_summary TEXT,
        findings_json TEXT,
        gate_run_id INTEGER,
        changeset_ref TEXT,
        turn_id TEXT,
        chat_uri TEXT,
        chat_cleanup_status TEXT CHECK (
          chat_cleanup_status IS NULL OR
          chat_cleanup_status IN ('pending', 'completed', 'error')
        ),
        chat_cleanup_error TEXT,
        chat_cleanup_attempts INTEGER NOT NULL DEFAULT 0,
        chat_cleanup_last_attempt_at TEXT,
        judgment_owner_id TEXT,
        judgment_lease_expires_at_ms INTEGER,
        start_owner_id TEXT,
        start_lease_expires_at_ms INTEGER,
        dispatch_host_url TEXT,
        dispatch_chat_disposable INTEGER,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_review_runs_card ON review_runs(card_id);
      CREATE INDEX IF NOT EXISTS idx_review_runs_status ON review_runs(status);

      CREATE TABLE IF NOT EXISTS heartbeat_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        detection TEXT NOT NULL,
        card_id TEXT,
        action_taken TEXT NOT NULL,
        detail TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_heartbeat_log_card ON heartbeat_log(card_id);

      CREATE TABLE IF NOT EXISTS card_status_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        card_id TEXT NOT NULL,
        message TEXT NOT NULL,
        recorded_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_card_status_history_card ON card_status_history(card_id);

      CREATE TABLE IF NOT EXISTS worker_status_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        card_id TEXT NOT NULL,
        worker_id TEXT NOT NULL,
        message TEXT NOT NULL,
        recorded_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_worker_status_history_worker
        ON worker_status_history(card_id, worker_id);

      CREATE TABLE IF NOT EXISTS coherence_conflicts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        card_a TEXT NOT NULL,
        card_b TEXT NOT NULL,
        tier TEXT NOT NULL,
        overlap_paths TEXT NOT NULL DEFAULT '[]',
        signature TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'detected',
        risk_snapshot TEXT,
        verdict_summary TEXT,
        findings_json TEXT,
        dismissed_signature TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        resolved_at TEXT,
        resolved_by TEXT,
        review_owner_id TEXT,
        review_lease_expires_at_ms INTEGER,
        UNIQUE (card_a, card_b)
      );

      CREATE INDEX IF NOT EXISTS idx_coherence_status ON coherence_conflicts(status);
      CREATE INDEX IF NOT EXISTS idx_coherence_card_a ON coherence_conflicts(card_a);
      CREATE INDEX IF NOT EXISTS idx_coherence_card_b ON coherence_conflicts(card_b);
    `);

    ensureSdkObservabilitySchema(db);
    ensureCtoContinuitySchema(db);
    ensureCoordinatorModeSchema(db);

    runSchemaMigration(db, () => {
      const gateRunsColumns = tableColumns(db!, "gate_runs");
      if (!gateRunsColumns.has("gate_name")) {
        db!.exec("ALTER TABLE gate_runs ADD COLUMN gate_name TEXT;");
        gateRunsColumns.add("gate_name");
      }
      if (!gateRunsColumns.has("changeset_ref")) {
        db!.exec("ALTER TABLE gate_runs ADD COLUMN changeset_ref TEXT;");
      }
    });

    // A dispatching review durably reserves its host/chat/turn identity before
    // the prompt side effect. Confirmed queued messages clear turn_id because
    // their message id is not guaranteed to become the eventual Turn.id.
    // Cleanup belongs to an immutable peer-chat URI, not to the mutable review
    // iteration row. Import legacy diagnostics once and independently retry them.
    ensureReviewRunSchema(db);
    ensureWorkLeaseSchema(db);
    ensureReviewChatCleanupSchema(db);
    recoverExpiredWork(db);

    ensureCardRiskSchema(db);
    ensureInboxSchema(db);

    db.exec(`
      UPDATE card_phases SET phase = 'review' WHERE phase = 'verify';
      UPDATE gate_runs
      SET from_phase = 'build', to_phase = 'review'
      WHERE from_phase = 'build' AND to_phase = 'verify';
      UPDATE gate_runs
      SET from_phase = 'build', to_phase = 'review'
      WHERE from_phase = 'verify' AND to_phase = 'review';
    `);
  }

  return db;
}
