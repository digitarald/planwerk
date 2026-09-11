import assert from "node:assert/strict";
import { test } from "node:test";

import Database from "better-sqlite3";

import { MessageDispatchAmbiguousError } from "../ahp/dispatch-confirmation.ts";
import { PeerChatCleanupRequiredError } from "../ahp/peer-review-dispatch.ts";
import {
  persistReviewStartFailure,
  shouldStartReviewForRun,
} from "./review-start-state.ts";

function createReviewDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE review_runs (
      id INTEGER PRIMARY KEY,
      status TEXT NOT NULL,
      verdict_summary TEXT,
      changeset_ref TEXT,
      chat_uri TEXT,
      turn_id TEXT,
      start_owner_id TEXT,
      start_lease_expires_at_ms INTEGER,
      dispatch_host_url TEXT,
      dispatch_chat_disposable INTEGER
    );
    CREATE TABLE review_chat_cleanups (
      host_url TEXT,
      chat_uri TEXT NOT NULL,
      turn_id TEXT,
      review_run_id INTEGER NOT NULL,
      status TEXT NOT NULL,
      error TEXT,
      dispatch_diagnostic TEXT,
      blocks_review_start INTEGER NOT NULL DEFAULT 0,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_attempt_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (host_url, chat_uri)
    );
    INSERT INTO review_runs (id, status, changeset_ref)
    VALUES (1, 'pending', 'before');
  `);
  return db;
}

test("unresolved peer dispatch persists identity and blocks duplicate injection", () => {
  const db = createReviewDb();
  const error = new MessageDispatchAmbiguousError(
    "The peer review prompt may have been dispatched.",
    {
      chatUri: "ahp-chat://review/1",
      turnId: "turn-1",
      cleanupError: new Error("dispose transport failed"),
    },
  );

  const failure = persistReviewStartFailure(db, "ws://host", 1, error);
  const row = db.prepare(
    "SELECT status, verdict_summary, changeset_ref AS changesetRef, chat_uri AS chatUri, turn_id AS turnId FROM review_runs WHERE id = 1",
  ).get() as {
    status: string;
    verdict_summary: string;
    changesetRef: string;
    chatUri: string | null;
    turnId: string | null;
  };

  assert.equal(failure.disposition, "needs-human");
  assert.equal(row.status, "ambiguous");
  assert.equal(row.chatUri, "ahp-chat://review/1");
  assert.equal(row.turnId, "turn-1");
  assert.match(row.verdict_summary, /dispose transport failed/);
  assert.deepEqual(
    db.prepare(`
      SELECT host_url, status, error, attempts
      FROM review_chat_cleanups
      WHERE chat_uri = 'ahp-chat://review/1'
    `).get(),
    {
      host_url: "ws://host/",
      status: "error",
      error: "dispose transport failed",
      attempts: 1,
    },
  );

  let duplicateInjections = 0;
  if (shouldStartReviewForRun(row, "changed-by-untracked-reviewer")) {
    duplicateInjections++;
  }
  assert.equal(duplicateInjections, 0);
  db.close();
});

test("confirmed disposal persists a retryable failure without live identity", () => {
  const db = createReviewDb();
  const failure = persistReviewStartFailure(
    db,
    "ws://host",
    1,
    "Dispatch was ambiguous, but peer chat disposal was confirmed.",
  );
  const row = db.prepare(
    "SELECT status, changeset_ref AS changesetRef, chat_uri AS chatUri, turn_id AS turnId FROM review_runs WHERE id = 1",
  ).get() as {
    status: string;
    changesetRef: string;
    chatUri: string | null;
    turnId: string | null;
  };

  assert.equal(failure.disposition, "retryable");
  assert.equal(row.status, "failed");
  assert.equal(row.chatUri, null);
  assert.equal(row.turnId, null);
  assert.equal(shouldStartReviewForRun(row, "after"), true);
  db.close();
});

test("proven pre-dispatch failure remains retryable", () => {
  const db = createReviewDb();
  const failure = persistReviewStartFailure(
    db,
    "ws://host",
    1,
    new Error("dispatch rejected before delivery"),
  );
  const row = db.prepare(
    "SELECT status, changeset_ref AS changesetRef FROM review_runs WHERE id = 1",
  ).get() as { status: string; changesetRef: string };

  assert.equal(failure.disposition, "retryable");
  assert.equal(row.status, "failed");
  assert.equal(shouldStartReviewForRun(row, "after"), true);
  db.close();
});

test("unknown current revision neither reuses nor starts review evidence", () => {
  assert.equal(
    shouldStartReviewForRun(
      { status: "passed", changesetRef: "source:revision-a" },
      undefined,
    ),
    false,
  );
  assert.equal(shouldStartReviewForRun(null, undefined), false);
});

test("create acknowledgement cleanup failure stays pre-dispatch and retryable", () => {
  const db = createReviewDb();
  const cleanupError = new Error("dispose transport failed");
  const failure = persistReviewStartFailure(
    db,
    "ws://host",
    1,
    new PeerChatCleanupRequiredError(
      "Create acknowledgement failed and cleanup failed",
      {
        cause: new Error("create response lost"),
        chatUri: "ahp-chat://review/create-retryable",
        cleanupError,
        dispatchAmbiguous: false,
      },
    ),
  );

  assert.equal(failure.status, "failed");
  assert.equal(failure.disposition, "retryable");
  assert.deepEqual(
    db.prepare(`
      SELECT status, chat_uri, turn_id
      FROM review_runs WHERE id = 1
    `).get(),
    {
      status: "failed",
      chat_uri: "ahp-chat://review/create-retryable",
      turn_id: null,
    },
  );
  assert.deepEqual(
    db.prepare(`
      SELECT chat_uri, review_run_id, status, error, attempts
      FROM review_chat_cleanups
    `).get(),
    {
      chat_uri: "ahp-chat://review/create-retryable",
      review_run_id: 1,
      status: "error",
      error: "dispose transport failed",
      attempts: 1,
    },
  );
  db.close();
});

test("cleanup-required ambiguous failure keeps needs-human semantics", () => {
  const db = createReviewDb();
  const failure = persistReviewStartFailure(
    db,
    "ws://host",
    1,
    new PeerChatCleanupRequiredError(
      "Dispatch confirmation and cleanup failed",
      {
        cause: new Error("ping failed"),
        chatUri: "ahp-chat://review/ambiguous",
        turnId: "turn-ambiguous",
        cleanupError: new Error("dispose failed"),
        dispatchAmbiguous: true,
      },
    ),
  );

  assert.equal(failure.status, "ambiguous");
  assert.equal(failure.disposition, "needs-human");
  assert.equal(
    (db.prepare(
      "SELECT attempts FROM review_chat_cleanups WHERE chat_uri = ?",
    ).get("ahp-chat://review/ambiguous") as { attempts: number }).attempts,
    1,
  );
  db.close();
});

test("lost failure owner still blocks on ambiguous peer cleanup identity", () => {
  const db = createReviewDb();
  db.prepare(`
    UPDATE review_runs
    SET start_owner_id = 'replacement', start_lease_expires_at_ms = 2000
    WHERE id = 1
  `).run();

  const failure = persistReviewStartFailure(
    db,
    "ws://host",
    1,
    new PeerChatCleanupRequiredError(
      "Replacement chat cleanup failed",
      {
        cause: new Error("pre-dispatch guard"),
        chatUri: "ahp-chat://review/replacement-cleanup",
        turnId: "turn-replacement-cleanup",
        cleanupError: new Error("dispose failed"),
        dispatchAmbiguous: true,
      },
    ),
    { ownerId: "expired-owner", now: 1_000 },
  );

  assert.equal(failure.applied, false);
  assert.deepEqual(
    db.prepare(`
      SELECT status, start_owner_id, chat_uri, turn_id
      FROM review_runs WHERE id = 1
    `).get(),
    {
      status: "pending",
      start_owner_id: "replacement",
      chat_uri: null,
      turn_id: null,
    },
  );
  assert.deepEqual(
    db.prepare(`
      SELECT host_url, chat_uri, turn_id, status, error, attempts,
        blocks_review_start
      FROM review_chat_cleanups
    `).get(),
    {
      host_url: "ws://host/",
      chat_uri: "ahp-chat://review/replacement-cleanup",
      turn_id: "turn-replacement-cleanup",
      status: "error",
      error: "dispose failed",
      attempts: 1,
      blocks_review_start: 1,
    },
  );
  db.close();
});
