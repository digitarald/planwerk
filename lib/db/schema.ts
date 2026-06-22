import "server-only";

import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!db) {
    const dbPath = path.join(process.cwd(), ".planwerk", "planwerk.db");

    fs.mkdirSync(path.dirname(dbPath), { recursive: true });

    db = new Database(dbPath);
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

      CREATE TABLE IF NOT EXISTS card_risk (
        card_id TEXT PRIMARY KEY,
        risk_level TEXT NOT NULL DEFAULT 'low',
        risk_factors TEXT NOT NULL DEFAULT '[]',
        assessed_at TEXT NOT NULL DEFAULT (datetime('now')),
        assessed_by TEXT NOT NULL DEFAULT 'copilot'
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
    `);

    // Mark any gate runs left running from a previous process as failed
    db.prepare(
      "UPDATE gate_runs SET status = 'failed', output = 'Abandoned: server restarted — re-run this gate', completed_at = datetime('now') WHERE status = 'running'"
    ).run();

    const gateRunsColumns = db
      .prepare("PRAGMA table_info(gate_runs)")
      .all() as Array<{ name: string }>;

    if (!gateRunsColumns.some((column) => column.name === "gate_name")) {
      db.exec("ALTER TABLE gate_runs ADD COLUMN gate_name TEXT;");
    }

    if (!gateRunsColumns.some((column) => column.name === "changeset_ref")) {
      db.exec("ALTER TABLE gate_runs ADD COLUMN changeset_ref TEXT;");
    }

    // Migrate card_risk: remove legacy FK constraint on card_id → card_phases
    const cardRiskFKs = db
      .prepare("PRAGMA foreign_key_list(card_risk)")
      .all() as Array<{ table: string }>;
    if (cardRiskFKs.length > 0) {
      db.pragma("foreign_keys = OFF");
      db.exec(`
        CREATE TABLE card_risk_new (
          card_id TEXT PRIMARY KEY,
          risk_level TEXT NOT NULL DEFAULT 'low',
          risk_factors TEXT NOT NULL DEFAULT '[]',
          assessed_at TEXT NOT NULL DEFAULT (datetime('now')),
          assessed_by TEXT NOT NULL DEFAULT 'copilot'
        );
        INSERT INTO card_risk_new SELECT * FROM card_risk;
        DROP TABLE card_risk;
        ALTER TABLE card_risk_new RENAME TO card_risk;
      `);
      db.pragma("foreign_keys = ON");
    }

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
