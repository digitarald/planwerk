import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import Database from "better-sqlite3";

import { ensureReviewChatCleanupSchema } from "./review-chat-cleanup-schema.ts";
import { ensureReviewRunSchema } from "./review-run-schema.ts";
import { claimReviewStart } from "./review-run-store.ts";
import {
  ensureWorkLeaseSchema,
  recoverExpiredWork,
} from "./work-lease-schema.ts";

function databasePath(): string {
  fs.mkdirSync(path.join(process.cwd(), ".planwerk"), { recursive: true });
  return path.join(
    process.cwd(),
    ".planwerk",
    `work-recovery-${randomUUID()}.db`,
  );
}

function cleanup(dbPath: string): void {
  fs.rmSync(dbPath, { force: true });
  fs.rmSync(`${dbPath}-wal`, { force: true });
  fs.rmSync(`${dbPath}-shm`, { force: true });
}

function open(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.exec(`
    CREATE TABLE IF NOT EXISTS gate_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      status TEXT NOT NULL DEFAULT 'running',
      output TEXT,
      completed_at TEXT
    );
    CREATE TABLE IF NOT EXISTS review_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      card_id TEXT NOT NULL,
      skill_id TEXT NOT NULL,
      phase_transition TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      iteration INTEGER NOT NULL DEFAULT 1,
      max_iterations INTEGER NOT NULL DEFAULT 2,
      prompt_injected_at TEXT,
      verdict_extracted_at TEXT,
      gate_run_id INTEGER,
      verdict_summary TEXT,
      findings_json TEXT,
      changeset_ref TEXT
    );
    CREATE TABLE IF NOT EXISTS coherence_conflicts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      status TEXT NOT NULL DEFAULT 'detected',
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  ensureReviewRunSchema(db);
  ensureWorkLeaseSchema(db);
  ensureReviewChatCleanupSchema(db);
  return db;
}

test("rolling-worker startup recovery preserves every live leased owner", () => {
  const dbPath = databasePath();
  const owner = open(dbPath);
  const starter = open(dbPath);
  try {
    const now = 10_000;
    owner.prepare(`
      INSERT INTO gate_runs (status, owner_id, lease_expires_at_ms)
      VALUES ('running', 'gate-worker', ?)
    `).run(now + 5_000);
    owner.prepare(`
      INSERT INTO coherence_conflicts (
        status, review_owner_id, review_lease_expires_at_ms
      ) VALUES ('reviewing', 'coherence-worker', ?)
    `).run(now + 5_000);
    const linkedGate = owner.prepare(`
      INSERT INTO gate_runs (status, owner_id, lease_expires_at_ms)
      VALUES ('running', 'review-worker', ?)
    `).run(now + 5_000);
    owner.prepare(`
      INSERT INTO review_runs (
        card_id, skill_id, phase_transition, status, gate_run_id,
        start_owner_id, start_lease_expires_at_ms
      ) VALUES ('card', 'review', 'build->review', 'pending', ?, ?, ?)
    `).run(
      Number(linkedGate.lastInsertRowid),
      "review-worker",
      now + 5_000,
    );

    assert.deepEqual(recoverExpiredWork(starter, now), {
      reviewStarts: 0,
      gates: 0,
      coherenceReviews: 0,
    });
    assert.equal(
      (owner.prepare(
        "SELECT count(*) AS count FROM gate_runs WHERE status = 'running'",
      ).get() as { count: number }).count,
      2,
    );
    assert.equal(
      (owner.prepare(
        "SELECT status FROM coherence_conflicts",
      ).get() as { status: string }).status,
      "reviewing",
    );
    assert.equal(
      (owner.prepare(
        "SELECT status FROM review_runs",
      ).get() as { status: string }).status,
      "pending",
    );
  } finally {
    owner.close();
    starter.close();
    cleanup(dbPath);
  }
});

test("crashed pending review claim and linked gate recover once without duplicate active work", () => {
  const dbPath = databasePath();
  const crashed = open(dbPath);
  const firstStarter = open(dbPath);
  const secondStarter = open(dbPath);
  try {
    const now = 20_000;
    const gate = crashed.prepare(`
      INSERT INTO gate_runs (status, owner_id, lease_expires_at_ms)
      VALUES ('running', 'dead-worker', ?)
    `).run(now - 1);
    crashed.prepare(`
      INSERT INTO review_runs (
        card_id, skill_id, phase_transition, status, gate_run_id,
        start_owner_id, start_lease_expires_at_ms
      ) VALUES ('card', 'review', 'build->review', 'pending', ?, ?, ?)
    `).run(Number(gate.lastInsertRowid), "dead-worker", now - 1);

    assert.deepEqual(recoverExpiredWork(firstStarter, now), {
      reviewStarts: 1,
      gates: 1,
      coherenceReviews: 0,
    });
    assert.deepEqual(recoverExpiredWork(secondStarter, now), {
      reviewStarts: 0,
      gates: 0,
      coherenceReviews: 0,
    });
    assert.deepEqual(
      crashed.prepare(`
        SELECT review_runs.status AS reviewStatus,
          gate_runs.status AS gateStatus
        FROM review_runs
        JOIN gate_runs ON gate_runs.id = review_runs.gate_run_id
      `).get(),
      { reviewStatus: "failed", gateStatus: "failed" },
    );

    const reclaimed = claimReviewStart(secondStarter, {
      cardId: "card",
      skillId: "review",
      phaseTransition: "build->review",
      maxIterations: 2,
      ownerId: "replacement-worker",
      leaseMs: 5_000,
      now,
    });
    assert.equal(reclaimed.state, "claimed");
    assert.equal(
      (crashed.prepare(`
        SELECT count(*) AS count FROM review_runs
        WHERE status IN ('pending', 'injected', 'extracting', 'ambiguous')
      `).get() as { count: number }).count,
      1,
    );
  } finally {
    crashed.close();
    firstStarter.close();
    secondStarter.close();
    cleanup(dbPath);
  }
});

test("expired standalone gate and coherence leases are recovered with CAS", () => {
  const dbPath = databasePath();
  const first = open(dbPath);
  const second = open(dbPath);
  try {
    const now = 30_000;
    first.prepare(`
      INSERT INTO gate_runs (status, owner_id, lease_expires_at_ms)
      VALUES ('running', 'dead-gate-worker', ?)
    `).run(now);
    first.prepare(`
      INSERT INTO coherence_conflicts (
        status, review_owner_id, review_lease_expires_at_ms
      ) VALUES ('reviewing', 'dead-coherence-worker', ?)
    `).run(now);

    assert.deepEqual(recoverExpiredWork(second, now), {
      reviewStarts: 0,
      gates: 1,
      coherenceReviews: 1,
    });
    assert.deepEqual(recoverExpiredWork(first, now), {
      reviewStarts: 0,
      gates: 0,
      coherenceReviews: 0,
    });
    assert.equal(
      (first.prepare("SELECT status FROM gate_runs").get() as {
        status: string;
      }).status,
      "failed",
    );
    assert.equal(
      (first.prepare("SELECT status FROM coherence_conflicts").get() as {
        status: string;
      }).status,
      "detected",
    );
  } finally {
    first.close();
    second.close();
    cleanup(dbPath);
  }
});
