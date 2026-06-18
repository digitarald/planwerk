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
        assessed_by TEXT NOT NULL DEFAULT 'copilot',
        FOREIGN KEY (card_id) REFERENCES card_phases(card_id)
      );

      CREATE INDEX IF NOT EXISTS idx_gate_runs_card ON gate_runs(card_id);
      CREATE INDEX IF NOT EXISTS idx_gate_runs_status ON gate_runs(status);
      CREATE INDEX IF NOT EXISTS idx_session_cache_host ON session_cache(host_url);
    `);

    const gateRunsColumns = db
      .prepare("PRAGMA table_info(gate_runs)")
      .all() as Array<{ name: string }>;

    if (!gateRunsColumns.some((column) => column.name === "gate_name")) {
      db.exec("ALTER TABLE gate_runs ADD COLUMN gate_name TEXT;");
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
