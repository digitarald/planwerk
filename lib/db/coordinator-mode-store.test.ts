import assert from "node:assert/strict";
import { test } from "node:test";

import Database from "better-sqlite3";

import { ensureCoordinatorModeSchema } from "./coordinator-mode-schema.ts";
import { CoordinatorModeStore } from "./coordinator-mode-store.ts";

function createStore(timestamps: string[] = []) {
  const db = new Database(":memory:");
  ensureCoordinatorModeSchema(db);
  const store = new CoordinatorModeStore(
    db,
    () => timestamps.shift() ?? "2026-09-21T00:00:00.000Z",
  );
  return { db, store };
}

test("coordinator mode schema starts with the safe board default", () => {
  const { db, store } = createStore();
  ensureCoordinatorModeSchema(db);

  assert.equal(store.getBoardDefault().mode, "observe");
  assert.deepEqual(store.listSessionOverrides(), []);
  assert.deepEqual(store.listAudit(), []);
  db.close();
});

test("board mode updates persist with their timestamp", () => {
  const updatedAt = "2026-09-21T01:02:03.004Z";
  const { db, store } = createStore([updatedAt]);

  assert.deepEqual(store.setBoardDefault("verify"), {
    mode: "verify",
    updatedAt,
  });
  assert.deepEqual(new CoordinatorModeStore(db).getBoardDefault(), {
    mode: "verify",
    updatedAt,
  });
  db.close();
});

test("session override takes precedence and removal restores board mode", () => {
  const { db, store } = createStore([
    "2026-09-21T01:00:00.000Z",
    "2026-09-21T02:00:00.000Z",
    "2026-09-21T03:00:00.000Z",
  ]);
  store.setBoardDefault("verify");
  store.setSessionOverride("http://host-a", "card-1", "coordinate");

  assert.deepEqual(store.getEffectiveMode("http://host-a", "card-1"), {
    hostUrl: "http://host-a",
    cardId: "card-1",
    mode: "coordinate",
    updatedAt: "2026-09-21T02:00:00.000Z",
    source: "session",
  });
  assert.equal(
    store.getEffectiveMode("http://host-b", "card-1").mode,
    "verify",
  );
  assert.equal(
    store.getEffectiveMode("http://host-a", "card-2").mode,
    "verify",
  );

  assert.equal(
    store.setSessionOverride("http://host-a", "card-1", null),
    null,
  );
  assert.deepEqual(store.getEffectiveMode("http://host-a", "card-1"), {
    hostUrl: "http://host-a",
    cardId: "card-1",
    mode: "verify",
    updatedAt: "2026-09-21T01:00:00.000Z",
    source: "board",
  });
  db.close();
});

test("invalid persisted modes fall back safely and are never overrides", () => {
  const { db, store } = createStore();
  db.pragma("ignore_check_constraints = ON");
  db.prepare(`
    UPDATE coordinator_board_mode SET mode = 'active'
    WHERE singleton_key = 'board'
  `).run();
  db.prepare(`
    INSERT INTO coordinator_session_modes (
      host_url, card_id, mode, updated_at
    ) VALUES ('http://host-a', 'card-1', 'active', 'corrupt')
  `).run();

  assert.equal(store.getBoardDefault().mode, "observe");
  assert.equal(store.getSessionOverride("http://host-a", "card-1"), null);
  assert.equal(
    store.getEffectiveMode("http://host-a", "card-1").mode,
    "observe",
  );
  assert.deepEqual(store.listSessionOverrides(), []);
  db.close();
});

test("board, override, and removal mutations write durable audit rows", () => {
  const timestamps = [
    "2026-09-21T01:00:00.000Z",
    "2026-09-21T02:00:00.000Z",
    "2026-09-21T03:00:00.000Z",
  ];
  const { db, store } = createStore([...timestamps]);
  store.setBoardDefault("verify");
  store.setSessionOverride("http://host-a", "card-1", "coordinate");
  store.setSessionOverride("http://host-a", "card-1", null);

  assert.deepEqual(
    new CoordinatorModeStore(db).listAudit(),
    [
      {
        id: 1,
        scope: "board",
        hostUrl: null,
        cardId: null,
        previousMode: "observe",
        mode: "verify",
        operation: "set",
        createdAt: timestamps[0],
      },
      {
        id: 2,
        scope: "session",
        hostUrl: "http://host-a",
        cardId: "card-1",
        previousMode: null,
        mode: "coordinate",
        operation: "set",
        createdAt: timestamps[1],
      },
      {
        id: 3,
        scope: "session",
        hostUrl: "http://host-a",
        cardId: "card-1",
        previousMode: "coordinate",
        mode: null,
        operation: "remove",
        createdAt: timestamps[2],
      },
    ],
  );
  db.close();
});
