import type Database from "better-sqlite3";

import { runSchemaMigration } from "./schema-migration.ts";

export function ensureCoordinatorModeSchema(db: Database.Database): void {
  runSchemaMigration(db, () => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS coordinator_board_mode (
        singleton_key TEXT PRIMARY KEY CHECK (singleton_key = 'board'),
        mode TEXT NOT NULL CHECK (mode IN ('observe', 'verify', 'coordinate')),
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS coordinator_session_modes (
        host_url TEXT NOT NULL CHECK (length(trim(host_url)) > 0),
        card_id TEXT NOT NULL CHECK (length(trim(card_id)) > 0),
        mode TEXT NOT NULL CHECK (mode IN ('observe', 'verify', 'coordinate')),
        updated_at TEXT NOT NULL,
        PRIMARY KEY (host_url, card_id)
      );

      CREATE TABLE IF NOT EXISTS coordinator_mode_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        scope TEXT NOT NULL CHECK (scope IN ('board', 'session')),
        host_url TEXT,
        card_id TEXT,
        previous_mode TEXT CHECK (
          previous_mode IS NULL OR
          previous_mode IN ('observe', 'verify', 'coordinate')
        ),
        mode TEXT CHECK (
          mode IS NULL OR mode IN ('observe', 'verify', 'coordinate')
        ),
        operation TEXT NOT NULL CHECK (operation IN ('set', 'remove')),
        created_at TEXT NOT NULL,
        CHECK (
          (scope = 'board' AND host_url IS NULL AND card_id IS NULL) OR
          (
            scope = 'session' AND
            host_url IS NOT NULL AND
            card_id IS NOT NULL AND
            length(trim(host_url)) > 0 AND
            length(trim(card_id)) > 0
          )
        )
      );

      CREATE INDEX IF NOT EXISTS idx_coordinator_session_modes_card
        ON coordinator_session_modes(card_id);
      CREATE INDEX IF NOT EXISTS idx_coordinator_mode_audit_created
        ON coordinator_mode_audit(created_at, id);

      INSERT INTO coordinator_board_mode (singleton_key, mode, updated_at)
      VALUES ('board', 'observe', datetime('now'))
      ON CONFLICT(singleton_key) DO NOTHING;
    `);
  });
}
