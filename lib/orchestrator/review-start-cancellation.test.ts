import assert from "node:assert/strict";
import { test } from "node:test";

import Database from "better-sqlite3";

import {
  awaitAbortableBoundary,
  isOperationAborted,
} from "../abort.ts";
import { terminalizeCancelledReviewStart } from "./review-start-cancellation.ts";

test("review cancellation before dispatch leaves no active review or gate", async () => {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE review_runs (
      id INTEGER PRIMARY KEY,
      status TEXT NOT NULL,
      verdict_summary TEXT
    );
    INSERT INTO review_runs (id, status) VALUES (1, 'pending');
  `);
  const controller = new AbortController();
  let resolveState!: () => void;
  const state = new Promise<void>((resolve) => {
    resolveState = resolve;
  });
  let dispatches = 0;
  let gateStatus: "running" | "passed" | "failed" = "running";

  const review = (async () => {
    try {
      await awaitAbortableBoundary(() => state, controller.signal);
      dispatches++;
    } catch (error) {
      if (!isOperationAborted(error)) throw error;
      terminalizeCancelledReviewStart(
        db,
        1,
        9,
        (_runId, status) => {
          gateStatus = status;
        },
      );
    }
  })();

  controller.abort();
  resolveState();
  await review;

  assert.equal(dispatches, 0);
  assert.equal(gateStatus, "failed");
  assert.deepEqual(
    db.prepare("SELECT status FROM review_runs").all(),
    [{ status: "cancelled" }],
  );
  assert.equal(
    (
      db.prepare(
        "SELECT count(*) AS count FROM review_runs WHERE status NOT IN ('passed', 'escalated', 'cancelled')",
      ).get() as { count: number }
    ).count,
    0,
  );
  db.close();
});
