import type Database from "better-sqlite3";

import { runSchemaMigration, tableColumns } from "./schema-migration.ts";

export function ensureInboxSchema(db: Database.Database): void {
  runSchemaMigration(db, () => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS inbox_items (
        id TEXT PRIMARY KEY,
        source_key TEXT NOT NULL UNIQUE,
        source_revision TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN (
          'pending-input',
          'runtime-error',
          'completion',
          'review-ready',
          'ship-ready',
          'gate-failure',
          'review-escalation',
          'conflict',
          'coordinator-action'
        )),
        priority_band TEXT NOT NULL CHECK (
          priority_band IN ('urgent', 'high', 'normal', 'low')
        ),
        priority_rank INTEGER NOT NULL,
        workflow_state TEXT NOT NULL DEFAULT 'open' CHECK (
          workflow_state IN ('open', 'resolved', 'dismissed')
        ),
        read_state TEXT NOT NULL DEFAULT 'unread' CHECK (
          read_state IN ('unread', 'read')
        ),
        card_id TEXT,
        related_card_ids_json TEXT NOT NULL DEFAULT '[]',
        title TEXT NOT NULL,
        briefing_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        read_at TEXT,
        resolved_at TEXT,
        pinned_at TEXT,
        snoozed_until TEXT
      );

      CREATE TABLE IF NOT EXISTS inbox_item_actions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        inbox_item_id TEXT NOT NULL,
        action_type TEXT NOT NULL,
        actor TEXT NOT NULL CHECK (actor = 'local-human'),
        note TEXT,
        previous_workflow_state TEXT NOT NULL,
        next_workflow_state TEXT NOT NULL,
        previous_read_state TEXT NOT NULL,
        next_read_state TEXT NOT NULL,
        snoozed_until TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (inbox_item_id) REFERENCES inbox_items(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_inbox_items_active_rank
        ON inbox_items(workflow_state, priority_rank DESC, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_inbox_items_card
        ON inbox_items(card_id, kind, workflow_state);
      CREATE INDEX IF NOT EXISTS idx_inbox_items_read
        ON inbox_items(read_state, workflow_state);
      CREATE INDEX IF NOT EXISTS idx_inbox_actions_item
        ON inbox_item_actions(inbox_item_id, id DESC);
    `);

    const itemColumns = tableColumns(db, "inbox_items");
    if (!itemColumns.has("pinned_at")) {
      db.exec("ALTER TABLE inbox_items ADD COLUMN pinned_at TEXT");
    }
    if (!itemColumns.has("snoozed_until")) {
      db.exec("ALTER TABLE inbox_items ADD COLUMN snoozed_until TEXT");
    }
    const actionColumns = tableColumns(db, "inbox_item_actions");
    if (!actionColumns.has("snoozed_until")) {
      db.exec(
        "ALTER TABLE inbox_item_actions ADD COLUMN snoozed_until TEXT",
      );
    }

    const actionTable = db.prepare(`
      SELECT sql FROM sqlite_master
      WHERE type = 'table' AND name = 'inbox_item_actions'
    `).get() as { sql: string } | undefined;
    if (actionTable?.sql.includes("CHECK (action_type IN")) {
      db.exec(`
        ALTER TABLE inbox_item_actions RENAME TO inbox_item_actions_legacy;

        CREATE TABLE inbox_item_actions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          inbox_item_id TEXT NOT NULL,
          action_type TEXT NOT NULL,
          actor TEXT NOT NULL CHECK (actor = 'local-human'),
          note TEXT,
          previous_workflow_state TEXT NOT NULL,
          next_workflow_state TEXT NOT NULL,
          previous_read_state TEXT NOT NULL,
          next_read_state TEXT NOT NULL,
          snoozed_until TEXT,
          created_at TEXT NOT NULL,
          FOREIGN KEY (inbox_item_id) REFERENCES inbox_items(id) ON DELETE CASCADE
        );

        INSERT INTO inbox_item_actions (
          id, inbox_item_id, action_type, actor, note,
          previous_workflow_state, next_workflow_state,
          previous_read_state, next_read_state, created_at
        )
        SELECT
          id, inbox_item_id, action_type, actor, note,
          previous_workflow_state, next_workflow_state,
          previous_read_state, next_read_state, created_at
        FROM inbox_item_actions_legacy;

        DROP TABLE inbox_item_actions_legacy;
        CREATE INDEX idx_inbox_actions_item
          ON inbox_item_actions(inbox_item_id, id DESC);
      `);
    }
  });
}
