import assert from "node:assert/strict";
import test from "node:test";

import Database from "better-sqlite3";

import { ensureInboxSchema } from "./inbox-schema.ts";

test("inbox schema creates durable item and action tables with constraints", () => {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  try {
    ensureInboxSchema(db);

    const tables = db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name IN ('inbox_items', 'inbox_item_actions')
      ORDER BY name
    `).all() as Array<{ name: string }>;
    assert.deepEqual(
      tables.map(({ name }) => name),
      ["inbox_item_actions", "inbox_items"],
    );

    const insertItem = db.prepare(`
      INSERT INTO inbox_items (
        id, source_key, source_revision, kind, priority_band, priority_rank,
        workflow_state, read_state, title, briefing_json, created_at, updated_at
      )
      VALUES (
        'item-1', 'source-1', 'revision-1', 'completion', 'normal', 190,
        'open', 'unread', 'Completed', '{}', '2026-09-22T00:00:00.000Z',
        '2026-09-22T00:00:00.000Z'
      )
    `);
    insertItem.run();
    assert.throws(() => insertItem.run(), /UNIQUE constraint failed/);
    assert.throws(() => {
      db.prepare(`
        INSERT INTO inbox_items (
          id, source_key, source_revision, kind, priority_band, priority_rank,
          workflow_state, read_state, title, briefing_json, created_at, updated_at
        )
        VALUES (
          'item-2', 'source-2', 'revision-2', 'unknown', 'normal', 1,
          'open', 'unread', 'Invalid', '{}', '2026-09-22T00:00:00.000Z',
          '2026-09-22T00:00:00.000Z'
        )
      `).run();
    }, /CHECK constraint failed/);

    db.prepare(`
      INSERT INTO inbox_item_actions (
        inbox_item_id, action_type, actor, previous_workflow_state,
        next_workflow_state, previous_read_state, next_read_state, created_at
      )
      VALUES (
        'item-1', 'read', 'local-human', 'open', 'open',
        'unread', 'read', '2026-09-22T00:01:00.000Z'
      )
    `).run();
    db.prepare("DELETE FROM inbox_items WHERE id = 'item-1'").run();
    const remaining = db.prepare(
      "SELECT count(*) AS count FROM inbox_item_actions",
    ).get() as { count: number };
    assert.equal(remaining.count, 0);
  } finally {
    db.close();
  }
});

test("inbox schema migrates legacy action constraints and adds local state", () => {
  const db = new Database(":memory:");
  try {
    db.exec(`
      CREATE TABLE inbox_items (
        id TEXT PRIMARY KEY,
        source_key TEXT NOT NULL UNIQUE,
        source_revision TEXT NOT NULL,
        kind TEXT NOT NULL,
        priority_band TEXT NOT NULL,
        priority_rank INTEGER NOT NULL,
        workflow_state TEXT NOT NULL,
        read_state TEXT NOT NULL,
        card_id TEXT,
        related_card_ids_json TEXT NOT NULL DEFAULT '[]',
        title TEXT NOT NULL,
        briefing_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        read_at TEXT,
        resolved_at TEXT
      );
      CREATE TABLE inbox_item_actions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        inbox_item_id TEXT NOT NULL,
        action_type TEXT NOT NULL CHECK (action_type IN (
          'mark-read', 'mark-unread', 'dismiss', 'resolve', 'reopen'
        )),
        actor TEXT NOT NULL CHECK (actor = 'local-human'),
        note TEXT,
        previous_workflow_state TEXT NOT NULL,
        next_workflow_state TEXT NOT NULL,
        previous_read_state TEXT NOT NULL,
        next_read_state TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
    ensureInboxSchema(db);

    const columns = db.prepare(
      "PRAGMA table_info(inbox_items)",
    ).all() as Array<{ name: string }>;
    assert.ok(columns.some(({ name }) => name === "pinned_at"));
    assert.ok(columns.some(({ name }) => name === "snoozed_until"));
    const actionSql = db.prepare(`
      SELECT sql FROM sqlite_master
      WHERE type = 'table' AND name = 'inbox_item_actions'
    `).get() as { sql: string };
    assert.doesNotMatch(actionSql.sql, /CHECK \(action_type IN/);
  } finally {
    db.close();
  }
});

test("inbox schema setup is idempotent", () => {
  const db = new Database(":memory:");
  try {
    ensureInboxSchema(db);
    ensureInboxSchema(db);
    const indexes = db.prepare(`
      SELECT count(*) AS count FROM sqlite_master
      WHERE type = 'index' AND name LIKE 'idx_inbox_%'
    `).get() as { count: number };
    assert.equal(indexes.count, 4);
  } finally {
    db.close();
  }
});
