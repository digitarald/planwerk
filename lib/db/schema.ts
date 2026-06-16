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

      CREATE INDEX IF NOT EXISTS idx_gate_runs_card ON gate_runs(card_id);
      CREATE INDEX IF NOT EXISTS idx_gate_runs_status ON gate_runs(status);
    `);
  }

  return db;
}
