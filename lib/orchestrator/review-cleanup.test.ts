import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import Database from "better-sqlite3";

import {
  attemptReviewPeerChatCleanup,
  recordReviewPeerChatCleanup,
  retryPendingReviewChatCleanup,
} from "./review-chat-cleanup.ts";

function createReviewDb() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE review_runs (
      id INTEGER PRIMARY KEY,
      status TEXT NOT NULL,
      verdict_summary TEXT,
      chat_uri TEXT
    );
    CREATE TABLE review_chat_cleanups (
      host_url TEXT,
      chat_uri TEXT NOT NULL,
      review_run_id INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      error TEXT,
      dispatch_diagnostic TEXT,
      blocks_review_start INTEGER NOT NULL DEFAULT 0,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_attempt_at TEXT,
      claim_owner TEXT,
      lease_expires_at_ms INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (host_url, chat_uri)
    );
  `);
  return db;
}

test("terminal review cleanup failure is persisted and later recovers", async () => {
  const db = createReviewDb();
  db.prepare(`
    INSERT INTO review_runs (id, status, verdict_summary, chat_uri)
    VALUES (1, 'passed', 'Approved', 'ahp-chat://review/1')
  `).run();
  const warnings: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(args);
  try {
    assert.equal(
      await attemptReviewPeerChatCleanup(
        db,
        "http://127.0.0.1:3000",
        1,
        "ahp-chat://review/1",
        async () => {
          throw new Error("host unavailable");
        },
      ),
      false,
    );
    assert.deepEqual(
      db.prepare(`
        SELECT r.status, r.verdict_summary, c.status AS cleanup_status,
          c.error AS cleanup_error, c.attempts AS cleanup_attempts
        FROM review_runs r
        JOIN review_chat_cleanups c ON c.review_run_id = r.id
        WHERE r.id = 1
      `).get(),
      {
        status: "passed",
        verdict_summary: "Approved",
        cleanup_status: "error",
        cleanup_error: "host unavailable",
        cleanup_attempts: 1,
      },
    );

    assert.equal(
      await retryPendingReviewChatCleanup(
        db,
        async () => {},
      ),
      1,
    );
    assert.deepEqual(
      db.prepare(`
        SELECT r.status, r.verdict_summary, c.status AS cleanup_status,
          c.error AS cleanup_error, c.attempts AS cleanup_attempts
        FROM review_runs r
        JOIN review_chat_cleanups c ON c.review_run_id = r.id
        WHERE r.id = 1
      `).get(),
      {
        status: "passed",
        verdict_summary: "Approved",
        cleanup_status: "completed",
        cleanup_error: null,
        cleanup_attempts: 2,
      },
    );
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(warnings.length, 1);
  assert.match(String(warnings[0][0]), /attempt 1\/3/);
  db.close();
});

test("permanent peer-chat cleanup failure stops after three attempts", async () => {
  const db = createReviewDb();
  db.prepare(`
    INSERT INTO review_runs (id, status, verdict_summary, chat_uri)
    VALUES (2, 'escalated', 'Needs human', 'ahp-chat://review/2')
  `).run();
  recordReviewPeerChatCleanup(
    db,
    "http://127.0.0.1:3000",
    2,
    "ahp-chat://review/2",
  );
  let calls = 0;
  const disposer = async () => {
    calls++;
    throw new Error("still unavailable");
  };
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    for (let index = 0; index < 5; index++) {
      await retryPendingReviewChatCleanup(
        db,
        disposer,
      );
    }
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(calls, 3);
  assert.deepEqual(
    db.prepare(`
      SELECT r.status, r.verdict_summary, c.status AS cleanup_status,
        c.error AS cleanup_error, c.attempts AS cleanup_attempts
      FROM review_runs r
      JOIN review_chat_cleanups c ON c.review_run_id = r.id
      WHERE r.id = 2
    `).get(),
    {
      status: "escalated",
      verdict_summary: "Needs human",
      cleanup_status: "error",
      cleanup_error: "still unavailable",
      cleanup_attempts: 3,
    },
  );
  db.close();
});

test("persisted initial disposal failure gets only two restart retries", async () => {
  const db = createReviewDb();
  db.prepare(`
    INSERT INTO review_runs (id, status, chat_uri)
    VALUES (3, 'failed', 'ahp-chat://review/3')
  `).run();
  recordReviewPeerChatCleanup(
    db,
    "http://host",
    3,
    "ahp-chat://review/3",
    { error: new Error("initial disposal failed"), attempts: 1 },
  );
  let calls = 0;
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    for (let restart = 0; restart < 4; restart++) {
      await retryPendingReviewChatCleanup(db, async () => {
        calls++;
        throw new Error(`restart disposal ${calls} failed`);
      });
    }
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(calls, 2);
  assert.deepEqual(
    db.prepare(`
      SELECT status, error, attempts
      FROM review_chat_cleanups
      WHERE chat_uri = 'ahp-chat://review/3'
    `).get(),
    {
      status: "error",
      error: "restart disposal 2 failed",
      attempts: 3,
    },
  );
  db.close();
});

test("new review iteration cannot erase an older chat cleanup", async () => {
  const db = createReviewDb();
  db.prepare(`
    INSERT INTO review_runs (id, status, verdict_summary, chat_uri)
    VALUES (4, 'failed', 'Old verdict', 'ahp-chat://review/old')
  `).run();
  recordReviewPeerChatCleanup(
    db,
    "http://host",
    4,
    "ahp-chat://review/old",
    { error: new Error("old cleanup failed"), attempts: 1 },
  );

  db.prepare(`
    UPDATE review_runs
    SET status = 'injected', verdict_summary = 'New iteration',
      chat_uri = 'ahp-chat://review/new'
    WHERE id = 4
  `).run();

  assert.equal(
    await retryPendingReviewChatCleanup(db, async (
      _hostUrl,
      chatUri,
    ) => {
      assert.equal(chatUri, "ahp-chat://review/old");
    }),
    1,
  );
  assert.deepEqual(
    db.prepare(`
      SELECT status, error, attempts
      FROM review_chat_cleanups
      WHERE chat_uri = 'ahp-chat://review/old'
    `).get(),
    { status: "completed", error: null, attempts: 2 },
  );
  assert.deepEqual(
    db.prepare(
      "SELECT status, verdict_summary, chat_uri FROM review_runs WHERE id = 4",
    ).get(),
    {
      status: "injected",
      verdict_summary: "New iteration",
      chat_uri: "ahp-chat://review/new",
    },
  );
  db.close();
});

function createTwoConnectionReviewDb() {
  fs.mkdirSync(path.join(process.cwd(), ".planwerk"), { recursive: true });
  const dbPath = path.join(
    process.cwd(),
    ".planwerk",
    `review-cleanup-test-${randomUUID()}.db`,
  );
  const first = new Database(dbPath);
  first.pragma("journal_mode = WAL");
  first.pragma("busy_timeout = 1000");
  first.exec(`
    CREATE TABLE review_runs (
      id INTEGER PRIMARY KEY,
      status TEXT NOT NULL,
      verdict_summary TEXT,
      chat_uri TEXT
    );
    CREATE TABLE review_chat_cleanups (
      host_url TEXT,
      chat_uri TEXT NOT NULL,
      review_run_id INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      error TEXT,
      dispatch_diagnostic TEXT,
      blocks_review_start INTEGER NOT NULL DEFAULT 0,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_attempt_at TEXT,
      claim_owner TEXT,
      lease_expires_at_ms INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (host_url, chat_uri)
    );
  `);
  const second = new Database(dbPath);
  second.pragma("busy_timeout = 1000");
  return {
    first,
    second,
    close() {
      first.close();
      second.close();
      fs.rmSync(dbPath, { force: true });
      fs.rmSync(`${dbPath}-wal`, { force: true });
      fs.rmSync(`${dbPath}-shm`, { force: true });
    },
  };
}

const noRenewalScheduler = {
  set() {
    return undefined;
  },
  clear() {},
};

test("two database connections dispose a claimed chat only once", async () => {
  const databases = createTwoConnectionReviewDb();
  try {
    databases.first.prepare(`
      INSERT INTO review_runs (id, status, chat_uri)
      VALUES (5, 'passed', 'ahp-chat://review/5')
    `).run();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });

    let calls = 0;
    const first = attemptReviewPeerChatCleanup(
      databases.first,
      "http://host",
      5,
      "ahp-chat://review/5",
      async () => {
        calls++;
        await blocked;
      },
    );
    await Promise.resolve();
    const second = attemptReviewPeerChatCleanup(
      databases.second,
      "http://host",
      5,
      "ahp-chat://review/5",
      async () => {
        calls++;
      },
    );
    assert.equal(await second, false);
    release();
    assert.equal(await first, true);
    assert.equal(calls, 1);
    assert.equal(
      (databases.second.prepare(`
        SELECT attempts FROM review_chat_cleanups
        WHERE chat_uri = 'ahp-chat://review/5'
      `).get() as { attempts: number }).attempts,
      1,
    );
  } finally {
    databases.close();
  }
});

test("one cleanup heartbeat retries every stored host without an active stream", async () => {
  const db = createReviewDb();
  recordReviewPeerChatCleanup(
    db,
    "WS://HOST-A:80",
    7,
    "ahp-chat://review/shared",
  );
  recordReviewPeerChatCleanup(
    db,
    "ws://host-b",
    8,
    "ahp-chat://review/shared",
  );

  const attempts: Array<{ hostUrl: string; chatUri: string }> = [];
  const callsByHost = new Map<string, number>();
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    for (let index = 0; index < 5; index++) {
      await retryPendingReviewChatCleanup(
        db,
        async (hostUrl, chatUri) => {
          attempts.push({ hostUrl, chatUri });
          const calls = (callsByHost.get(hostUrl) ?? 0) + 1;
          callsByHost.set(hostUrl, calls);
          if (hostUrl === "ws://host-a/" || calls < 3) {
            throw new Error(`${hostUrl} unavailable`);
          }
        },
      );
    }
    assert.deepEqual(attempts, [
      { hostUrl: "ws://host-a/", chatUri: "ahp-chat://review/shared" },
      { hostUrl: "ws://host-b/", chatUri: "ahp-chat://review/shared" },
      { hostUrl: "ws://host-a/", chatUri: "ahp-chat://review/shared" },
      { hostUrl: "ws://host-b/", chatUri: "ahp-chat://review/shared" },
      { hostUrl: "ws://host-a/", chatUri: "ahp-chat://review/shared" },
      { hostUrl: "ws://host-b/", chatUri: "ahp-chat://review/shared" },
    ]);
    assert.deepEqual(
      db.prepare(`
        SELECT host_url, status, attempts, error
        FROM review_chat_cleanups
        ORDER BY host_url
      `).all(),
      [
        {
          host_url: "ws://host-a/",
          status: "error",
          attempts: 3,
          error: "ws://host-a/ unavailable",
        },
        {
          host_url: "ws://host-b/",
          status: "completed",
          attempts: 3,
          error: null,
        },
      ],
    );
    assert.deepEqual(Object.fromEntries(callsByHost), {
      "ws://host-a/": 3,
      "ws://host-b/": 3,
    });
  } finally {
    console.warn = originalWarn;
  }
  db.close();
});

test("stale cleanup owner cannot complete a replacement claim", async () => {
  const databases = createTwoConnectionReviewDb();
  let now = 1_000;
  try {
    databases.first.prepare(`
      INSERT INTO review_runs (id, status, chat_uri)
      VALUES (6, 'passed', 'ahp-chat://review/6')
    `).run();
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const secondBlocked = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    const first = attemptReviewPeerChatCleanup(
      databases.first,
      "http://host",
      6,
      "ahp-chat://review/6",
      async () => firstBlocked,
      {
        ownerId: "owner-a",
        now: () => now,
        leaseMs: 100,
        scheduler: noRenewalScheduler,
      },
    );
    await Promise.resolve();
    now = 1_101;
    const replacement = attemptReviewPeerChatCleanup(
      databases.second,
      "http://host",
      6,
      "ahp-chat://review/6",
      async () => secondBlocked,
      {
        ownerId: "owner-b",
        now: () => now,
        leaseMs: 100,
        scheduler: noRenewalScheduler,
      },
    );
    await Promise.resolve();

    releaseFirst();
    assert.equal(await first, false);
    assert.deepEqual(
      databases.first.prepare(`
        SELECT status, claim_owner, attempts
        FROM review_chat_cleanups
        WHERE chat_uri = 'ahp-chat://review/6'
      `).get(),
      { status: "in_progress", claim_owner: "owner-b", attempts: 2 },
    );
    releaseSecond();
    assert.equal(await replacement, true);
  } finally {
    databases.close();
  }
});
