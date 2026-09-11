import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import Database from "better-sqlite3";

import { retryPendingReviewChatCleanup } from "../orchestrator/review-chat-cleanup.ts";
import { ensureReviewChatCleanupSchema } from "./review-chat-cleanup-schema.ts";

test("schema migration quarantines cleanup rows without an originating host", async () => {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE review_runs (
      id INTEGER PRIMARY KEY,
      status TEXT NOT NULL,
      chat_uri TEXT,
      chat_cleanup_status TEXT,
      chat_cleanup_error TEXT,
      chat_cleanup_attempts INTEGER NOT NULL DEFAULT 0,
      chat_cleanup_last_attempt_at TEXT
    );
    INSERT INTO review_runs (
      id, status, chat_uri, chat_cleanup_status,
      chat_cleanup_error, chat_cleanup_attempts
    )
    VALUES (
      7, 'failed', 'ahp-chat://review/restart', 'error',
      'legacy disposal failed', 1
    );
  `);

  ensureReviewChatCleanupSchema(db);
  assert.deepEqual(
    db.prepare(`
      SELECT host_url, review_run_id, status, attempts
      FROM review_chat_cleanups
    `).get(),
    {
      host_url: null,
      review_run_id: 7,
      status: "quarantined",
      attempts: 1,
    },
  );
  assert.match(
    (db.prepare(`
      SELECT error FROM review_chat_cleanups
    `).get() as { error: string }).error,
    /legacy disposal failed.*originating AHP host cannot be recovered/,
  );

  ensureReviewChatCleanupSchema(db);
  assert.deepEqual(
    db.prepare(`
      SELECT status, attempts, claim_owner, lease_expires_at_ms
      FROM review_chat_cleanups
    `).get(),
    {
      status: "quarantined",
      attempts: 1,
      claim_owner: null,
      lease_expires_at_ms: null,
    },
  );

  let disposals = 0;
  assert.equal(
    await retryPendingReviewChatCleanup(db, async () => {
      disposals++;
    }),
    0,
  );
  assert.equal(disposals, 0);
  assert.deepEqual(
    db.prepare(`
      SELECT status, error, attempts
      FROM review_chat_cleanups
    `).get(),
    {
      status: "quarantined",
      error:
        "legacy disposal failed Quarantined: originating AHP host cannot be recovered.",
      attempts: 1,
    },
  );
  db.close();
});

test("schema initialization on another connection cannot steal a live claim", () => {
  fs.mkdirSync(path.join(process.cwd(), ".planwerk"), { recursive: true });
  const dbPath = path.join(
    process.cwd(),
    ".planwerk",
    `review-schema-test-${randomUUID()}.db`,
  );
  const first = new Database(dbPath);
  const second = new Database(dbPath);
  try {
    first.pragma("journal_mode = WAL");
    first.exec(`
      CREATE TABLE review_runs (
        id INTEGER PRIMARY KEY,
        status TEXT NOT NULL,
        chat_uri TEXT,
        chat_cleanup_status TEXT,
        chat_cleanup_error TEXT,
        chat_cleanup_attempts INTEGER NOT NULL DEFAULT 0,
        chat_cleanup_last_attempt_at TEXT
      );
    `);
    ensureReviewChatCleanupSchema(first);
    first.prepare(`
      INSERT INTO review_chat_cleanups (
        host_url, chat_uri, review_run_id, status, attempts,
        claim_owner, lease_expires_at_ms
      ) VALUES (?, ?, ?, 'in_progress', 1, ?, ?)
    `).run(
      "ws://host-a/",
      "ahp-chat://review/live",
      9,
      "worker-a",
      Date.now() + 60_000,
    );

    ensureReviewChatCleanupSchema(second);
    assert.deepEqual(
      second.prepare(`
        SELECT status, claim_owner, attempts
        FROM review_chat_cleanups
        WHERE chat_uri = 'ahp-chat://review/live'
      `).get(),
      { status: "in_progress", claim_owner: "worker-a", attempts: 1 },
    );
  } finally {
    first.close();
    second.close();
    fs.rmSync(dbPath, { force: true });
    fs.rmSync(`${dbPath}-wal`, { force: true });
    fs.rmSync(`${dbPath}-shm`, { force: true });
  }
});

test("only an expired cleanup claim can be recovered", async () => {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE review_runs (
      id INTEGER PRIMARY KEY,
      status TEXT NOT NULL,
      chat_uri TEXT,
      chat_cleanup_status TEXT,
      chat_cleanup_error TEXT,
      chat_cleanup_attempts INTEGER NOT NULL DEFAULT 0,
      chat_cleanup_last_attempt_at TEXT
    );
  `);
  ensureReviewChatCleanupSchema(db);
  db.prepare(`
    INSERT INTO review_chat_cleanups (
      host_url, chat_uri, review_run_id, status, attempts,
      claim_owner, lease_expires_at_ms
    ) VALUES (?, ?, ?, 'in_progress', 1, ?, ?)
  `).run(
    "ws://host/",
    "ahp-chat://review/leased",
    10,
    "worker-a",
    1_100,
  );
  const options = {
    now: () => 1_000,
    ownerId: "worker-b",
    leaseMs: 100,
  };
  let disposals = 0;
  assert.equal(
    await retryPendingReviewChatCleanup(
      db,
      async () => {
        disposals++;
      },
      options,
    ),
    0,
  );
  assert.equal(disposals, 0);

  options.now = () => 1_101;
  assert.equal(
    await retryPendingReviewChatCleanup(
      db,
      async () => {
        disposals++;
      },
      options,
    ),
    1,
  );
  assert.equal(disposals, 1);
  assert.deepEqual(
    db.prepare(`
      SELECT status, claim_owner, attempts
      FROM review_chat_cleanups
      WHERE chat_uri = 'ahp-chat://review/leased'
    `).get(),
    { status: "completed", claim_owner: null, attempts: 2 },
  );
  db.close();
});
