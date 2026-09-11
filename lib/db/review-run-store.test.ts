import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import Database from "better-sqlite3";

import { ensureReviewChatCleanupSchema } from "./review-chat-cleanup-schema.ts";
import { ensureReviewRunSchema } from "./review-run-schema.ts";
import {
  ensureWorkLeaseSchema,
  recoverExpiredWork,
} from "./work-lease-schema.ts";
import {
  claimReviewJudgment,
  claimReviewStart,
  commitOwnedReviewDispatch,
  commitOwnedReviewOutcome,
  failOwnedReviewIfSourceChanged,
  linkOwnedReviewStartGate,
  renewReviewJudgmentLease,
  renewReviewStartLease,
} from "./review-run-store.ts";
import {
  retryPendingReviewChatCleanup,
} from "../orchestrator/review-chat-cleanup.ts";
import {
  finalizeOwnedReviewDispatch,
  prepareOwnedReviewDispatch,
  reconcileRecoveredReviewDispatch,
} from "../orchestrator/review-start-state.ts";

function databasePath(): string {
  fs.mkdirSync(path.join(process.cwd(), ".planwerk"), { recursive: true });
  return path.join(
    process.cwd(),
    ".planwerk",
    `review-run-store-${randomUUID()}.db`,
  );
}

function removeDatabase(dbPath: string): void {
  fs.rmSync(dbPath, { force: true });
  fs.rmSync(`${dbPath}-wal`, { force: true });
  fs.rmSync(`${dbPath}-shm`, { force: true });
}

function openReviewDb(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.exec(`
    CREATE TABLE IF NOT EXISTS gate_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      status TEXT NOT NULL DEFAULT 'running',
      output TEXT,
      completed_at TEXT,
      changeset_ref TEXT
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
      verdict_summary TEXT,
      findings_json TEXT,
      gate_run_id INTEGER,
      changeset_ref TEXT,
      turn_id TEXT,
      chat_uri TEXT,
      chat_cleanup_status TEXT,
      chat_cleanup_error TEXT,
      chat_cleanup_attempts INTEGER NOT NULL DEFAULT 0,
      chat_cleanup_last_attempt_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
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

function attachGate(
  db: Database.Database,
  reviewRunId: number,
  changesetRef: string,
): number {
  const gate = db.prepare(`
    INSERT INTO gate_runs (status, changeset_ref)
    VALUES ('running', ?)
  `).run(changesetRef);
  const gateRunId = Number(gate.lastInsertRowid);
  db.prepare(`
    UPDATE review_runs
    SET status = 'injected', gate_run_id = ?
    WHERE id = ?
  `).run(gateRunId, reviewRunId);
  return gateRunId;
}

test("independent connections share one active review start claim", () => {
  const dbPath = databasePath();
  const first = openReviewDb(dbPath);
  const second = openReviewDb(dbPath);
  try {
    const input = {
      cardId: "card-1",
      skillId: "code-review",
      phaseTransition: "build->review",
      maxIterations: 2,
      changesetRef: "revision-a",
      ownerId: "worker-a",
      leaseMs: 1_000,
      now: 1_000,
    };
    const firstClaim = claimReviewStart(first, input);
    const secondClaim = claimReviewStart(second, input);

    assert.equal(firstClaim.state, "claimed");
    assert.equal(secondClaim.state, "active");
    assert.equal(secondClaim.reviewRunId, firstClaim.reviewRunId);
    assert.equal(
      (
        second.prepare(`
          SELECT count(*) AS count
          FROM review_runs
          WHERE card_id = ? AND skill_id = ? AND phase_transition = ?
            AND status IN (
              'pending', 'dispatching', 'injected', 'extracting', 'ambiguous'
            )
        `).get(
          input.cardId,
          input.skillId,
          input.phaseTransition,
        ) as { count: number }
      ).count,
      1,
    );

    assert.equal(
      claimReviewStart(second, {
        ...input,
        phaseTransition: "plan->build",
        ownerId: "worker-b",
      }).state,
      "claimed",
    );
  } finally {
    first.close();
    second.close();
    removeDatabase(dbPath);
  }
});

test("pending dispatch claims renew and fence a crashed owner across connections", () => {
  const dbPath = databasePath();
  const first = openReviewDb(dbPath);
  const second = openReviewDb(dbPath);
  try {
    const input = {
      cardId: "card-dispatch",
      skillId: "code-review",
      phaseTransition: "build->review",
      maxIterations: 1,
      changesetRef: "revision-a",
      ownerId: "worker-a",
      leaseMs: 100,
      now: 1_000,
    };
    const start = claimReviewStart(first, input);
    const gate = first.prepare(`
      INSERT INTO gate_runs (
        status, changeset_ref, owner_id, lease_expires_at_ms
      ) VALUES ('running', 'revision-a', 'worker-a', 1100)
    `).run();
    const gateRunId = Number(gate.lastInsertRowid);
    assert.equal(
      linkOwnedReviewStartGate(
        first,
        start.reviewRunId,
        "worker-a",
        gateRunId,
        1_001,
      ),
      true,
    );
    assert.equal(
      renewReviewStartLease(
        first,
        start.reviewRunId,
        "worker-a",
        100,
        1_050,
      ),
      true,
    );
    assert.equal(
      claimReviewStart(second, { ...input, ownerId: "worker-b", now: 1_101 })
        .state,
      "active",
    );

    const replacement = claimReviewStart(second, {
      ...input,
      ownerId: "worker-b",
      now: 1_151,
    });
    assert.equal(replacement.state, "claimed");
    assert.equal(replacement.reviewRunId, start.reviewRunId);
    assert.equal(replacement.iteration, 1);
    assert.equal(
      commitOwnedReviewDispatch(
        first,
        start.reviewRunId,
        "worker-a",
        "turn-stale",
        "chat-stale",
        1_152,
      ),
      false,
    );
    assert.equal(
      (second.prepare(
        "SELECT status FROM gate_runs WHERE id = ?",
      ).get(gateRunId) as { status: string }).status,
      "failed",
    );
    assert.equal(
      (second.prepare(`
        SELECT count(*) AS count FROM review_runs
        WHERE status IN (
          'pending', 'dispatching', 'injected', 'extracting', 'ambiguous'
        )
      `).get() as { count: number }).count,
      1,
    );
  } finally {
    first.close();
    second.close();
    removeDatabase(dbPath);
  }
});

test("dispatch reservation closes lease-expiry race before owner finalizes", async () => {
  const dbPath = databasePath();
  const first = openReviewDb(dbPath);
  const second = openReviewDb(dbPath);
  try {
    const input = {
      cardId: "card-dispatch-cleanup",
      skillId: "code-review",
      phaseTransition: "plan->build",
      maxIterations: 1,
      changesetRef: "revision-a",
      ownerId: "worker-a",
      leaseMs: 100,
      now: 1_000,
    };
    const start = claimReviewStart(first, input);
    assert.equal(prepareOwnedReviewDispatch(first, {
      reviewRunId: start.reviewRunId,
      ownerId: "worker-a",
      hostUrl: "WS://REVIEW-HOST:80",
      chatUri: "ahp-chat://review/orphaned",
      turnId: "turn-orphaned",
      disposablePeerChat: true,
      now: 1_001,
    }).state, "ready");

    let promptDispatches = 1;
    const recovered = reconcileRecoveredReviewDispatch(second, {
      cardId: input.cardId,
      skillId: input.skillId,
      phaseTransition: input.phaseTransition,
      now: 1_101,
    });
    assert.equal(recovered?.reviewRunId, start.reviewRunId);
    const replacement = claimReviewStart(second, {
      ...input,
      ownerId: "worker-b",
      now: 1_101,
    });
    assert.equal(replacement.state, "ambiguous");
    const preparation = prepareOwnedReviewDispatch(second, {
      reviewRunId: start.reviewRunId,
      ownerId: "worker-b",
      hostUrl: "ws://review-host",
      chatUri: "ahp-chat://review/duplicate",
      turnId: "turn-duplicate",
      disposablePeerChat: true,
      now: 1_102,
    });
    if (preparation.state === "ready") promptDispatches++;
    assert.equal(preparation.state, "lost");
    assert.equal(promptDispatches, 1);

    const finalized = finalizeOwnedReviewDispatch(first, {
      hostUrl: "WS://REVIEW-HOST:80",
      reviewRunId: start.reviewRunId,
      ownerId: "worker-a",
      turnId: "turn-orphaned",
      chatUri: "ahp-chat://review/orphaned",
      disposablePeerChat: true,
      now: 1_103,
    });
    assert.equal(finalized.state, "orphaned");
    assert.deepEqual(
      first.prepare(`
        SELECT status, start_owner_id, chat_uri, turn_id
        FROM review_runs WHERE id = ?
      `).get(start.reviewRunId),
      {
        status: "ambiguous",
        start_owner_id: null,
        chat_uri: "ahp-chat://review/orphaned",
        turn_id: "turn-orphaned",
      },
    );
    assert.deepEqual(
      second.prepare(`
        SELECT host_url, chat_uri, turn_id, status, attempts,
          blocks_review_start
        FROM review_chat_cleanups
        WHERE review_run_id = ?
      `).get(start.reviewRunId),
      {
        host_url: "ws://review-host/",
        chat_uri: "ahp-chat://review/orphaned",
        turn_id: "turn-orphaned",
        status: "pending",
        attempts: 0,
        blocks_review_start: 1,
      },
    );

    let cleanupCalls = 0;
    assert.equal(
      await retryPendingReviewChatCleanup(first, async (hostUrl, chatUri) => {
        cleanupCalls++;
        assert.equal(hostUrl, "ws://review-host/");
        assert.equal(chatUri, "ahp-chat://review/orphaned");
      }),
      1,
    );
    assert.equal(cleanupCalls, 1);
  } finally {
    first.close();
    second.close();
    removeDatabase(dbPath);
  }
});

test("crash before dispatch confirmation recovers ambiguous without default-chat redispatch", () => {
      const dbPath = databasePath();
      const first = openReviewDb(dbPath);
      const second = openReviewDb(dbPath);
      try {
        const input = {
          cardId: "card-default-dispatch",
          skillId: "code-review",
          phaseTransition: "build->review",
          maxIterations: 1,
          changesetRef: "revision-a",
          ownerId: "worker-a",
          leaseMs: 100,
          now: 2_000,
        };
        const start = claimReviewStart(first, input);
        assert.equal(prepareOwnedReviewDispatch(first, {
          reviewRunId: start.reviewRunId,
          ownerId: "worker-a",
          hostUrl: "ws://host",
          chatUri: "ahp-chat://default/session",
          turnId: "turn-default",
          disposablePeerChat: false,
          now: 2_001,
        }).state, "ready");
        assert.equal(
          recoverExpiredWork(second, 2_101).reviewStarts,
          1,
        );
        assert.equal(
          claimReviewStart(second, {
            ...input,
            ownerId: "worker-b",
            now: 2_102,
          }).state,
          "ambiguous",
        );
        assert.deepEqual(
          first.prepare(`
            SELECT status, chat_uri, turn_id FROM review_runs WHERE id = ?
          `).get(start.reviewRunId),
          {
            status: "ambiguous",
            chat_uri: "ahp-chat://default/session",
            turn_id: "turn-default",
          },
        );
        assert.deepEqual(
          first.prepare(`
            SELECT status, blocks_review_start
            FROM review_chat_cleanups WHERE review_run_id = ?
          `).get(start.reviewRunId),
          { status: "quarantined", blocks_review_start: 1 },
        );
      } finally {
        first.close();
        second.close();
        removeDatabase(dbPath);
      }
});

test("judgment lease fences verdict and gate writes across connections", () => {
  const dbPath = databasePath();
  const first = openReviewDb(dbPath);
  const second = openReviewDb(dbPath);
  try {
    const start = claimReviewStart(first, {
      cardId: "card-lease",
      skillId: "code-review",
      phaseTransition: "build->review",
      maxIterations: 2,
      changesetRef: "revision-a",
      ownerId: "worker-a",
      leaseMs: 1_000,
      now: 1_000,
    });
    const gateRunId = attachGate(first, start.reviewRunId, "revision-a");

    assert.ok(
      claimReviewJudgment(first, start.reviewRunId, "worker-a", 100, 1_000),
    );
    assert.equal(
      claimReviewJudgment(second, start.reviewRunId, "worker-b", 100, 1_050),
      null,
    );
    assert.equal(
      renewReviewJudgmentLease(
        first,
        start.reviewRunId,
        "worker-a",
        100,
        1_050,
      ),
      true,
    );
    assert.equal(
      claimReviewJudgment(second, start.reviewRunId, "worker-b", 100, 1_101),
      null,
    );

    assert.ok(
      claimReviewJudgment(second, start.reviewRunId, "worker-b", 100, 1_151),
    );
    const outcome = {
      reviewStatus: "passed" as const,
      verdictSummary: "No blockers.",
      findings: [],
      gateStatus: "passed" as const,
      gateOutput: "No blockers.",
    };
    assert.equal(
      commitOwnedReviewOutcome(
        first,
        start.reviewRunId,
        "worker-a",
        outcome,
        1_152,
      ),
      false,
    );
    assert.deepEqual(
      second.prepare(`
        SELECT status, judgment_owner_id AS owner
        FROM review_runs WHERE id = ?
      `).get(start.reviewRunId),
      { status: "extracting", owner: "worker-b" },
    );
    assert.equal(
      (second.prepare(
        "SELECT status FROM gate_runs WHERE id = ?",
      ).get(gateRunId) as { status: string }).status,
      "running",
    );

    assert.equal(
      commitOwnedReviewOutcome(
        second,
        start.reviewRunId,
        "worker-b",
        outcome,
        1_152,
      ),
      true,
    );
    assert.deepEqual(
      first.prepare(`
        SELECT status, changeset_ref AS changesetRef,
          judgment_owner_id AS owner,
          judgment_lease_expires_at_ms AS lease
        FROM review_runs WHERE id = ?
      `).get(start.reviewRunId),
      {
        status: "passed",
        changesetRef: "revision-a",
        owner: "worker-b",
        lease: null,
      },
    );
    assert.deepEqual(
      first.prepare(`
        SELECT status, changeset_ref AS changesetRef
        FROM gate_runs WHERE id = ?
      `).get(gateRunId),
      { status: "passed", changesetRef: "revision-a" },
    );
  } finally {
    first.close();
    second.close();
    removeDatabase(dbPath);
  }
});

test("revision A evidence is failed stale and requeued against revision B", () => {
  const dbPath = databasePath();
  const db = openReviewDb(dbPath);
  try {
    const start = claimReviewStart(db, {
      cardId: "card-revision",
      skillId: "code-review",
      phaseTransition: "build->review",
      maxIterations: 2,
      changesetRef: "revision-a",
      ownerId: "worker-a",
      leaseMs: 1_000,
      now: 2_000,
    });

    const gateRunId = attachGate(db, start.reviewRunId, "revision-a");
    assert.ok(
      claimReviewJudgment(db, start.reviewRunId, "worker-a", 100, 2_000),
    );

    assert.equal(
      failOwnedReviewIfSourceChanged(
        db,
        start.reviewRunId,
        "worker-a",
        "revision-b",
        2_001,
      ),
      "stale",
    );
    assert.deepEqual(
      db.prepare(`
        SELECT status, changeset_ref AS changesetRef,
          verdict_extracted_at AS verdictExtractedAt
        FROM review_runs WHERE id = ?
      `).get(start.reviewRunId),
      {
        status: "failed",
        changesetRef: "revision-a",
        verdictExtractedAt: null,
      },
    );
    assert.deepEqual(
      db.prepare(`
        SELECT status, changeset_ref AS changesetRef
        FROM gate_runs WHERE id = ?
      `).get(gateRunId),
      { status: "failed", changesetRef: "revision-a" },
    );

    const retry = claimReviewStart(db, {
      cardId: "card-revision",
      skillId: "code-review",
      phaseTransition: "build->review",
      maxIterations: 2,
      changesetRef: "revision-b",
      ownerId: "worker-b",
      leaseMs: 1_000,
      now: 2_001,
    });
    assert.equal(retry.state, "claimed");
    assert.equal(retry.reviewRunId, start.reviewRunId);
    assert.equal(retry.iteration, 2);
    assert.equal(
      (db.prepare(
        "SELECT changeset_ref FROM review_runs WHERE id = ?",
      ).get(start.reviewRunId) as { changeset_ref: string }).changeset_ref,
      "revision-b",
    );
  } finally {
    db.close();
    removeDatabase(dbPath);
  }
});

test("revision A evidence fails closed when the current revision is unknown", () => {
  const dbPath = databasePath();
  const db = openReviewDb(dbPath);
  try {
    const start = claimReviewStart(db, {
      cardId: "card-unknown-revision",
      skillId: "code-review",
      phaseTransition: "build->review",
      maxIterations: 2,
      changesetRef: "source:revision-a",
      ownerId: "worker-a",
      leaseMs: 1_000,
      now: 2_000,
    });
    const gateRunId = attachGate(db, start.reviewRunId, "source:revision-a");
    assert.ok(
      claimReviewJudgment(db, start.reviewRunId, "worker-a", 100, 2_000),
    );

    assert.equal(
      failOwnedReviewIfSourceChanged(
        db,
        start.reviewRunId,
        "worker-a",
        undefined,
        2_001,
      ),
      "stale",
    );
    assert.match(
      (db.prepare(`
        SELECT verdict_summary FROM review_runs WHERE id = ?
      `).get(start.reviewRunId) as { verdict_summary: string }).verdict_summary,
      /current source revision is unavailable/i,
    );
    assert.equal(
      (db.prepare(`
        SELECT status FROM gate_runs WHERE id = ?
      `).get(gateRunId) as { status: string }).status,
      "failed",
    );
  } finally {
    db.close();
    removeDatabase(dbPath);
  }
});

test("review schema migration is repeatable and repairs legacy duplicates", () => {
  const dbPath = databasePath();
  const first = new Database(dbPath);
  const second = new Database(dbPath);
  try {
    first.exec(`
      CREATE TABLE review_runs (
        id INTEGER PRIMARY KEY,
        card_id TEXT NOT NULL,
        skill_id TEXT NOT NULL,
        phase_transition TEXT NOT NULL,
        status TEXT NOT NULL,
        verdict_summary TEXT
      );
      INSERT INTO review_runs
        (id, card_id, skill_id, phase_transition, status)
      VALUES
        (1, 'card', 'skill', 'build->review', 'pending'),
        (2, 'card', 'skill', 'build->review', 'injected');
    `);

    ensureReviewRunSchema(first);
    first.prepare(`
      UPDATE review_runs
      SET status = 'extracting',
          judgment_owner_id = 'worker-live',
          judgment_lease_expires_at_ms = ?
      WHERE id = 2
    `).run(Date.now() + 60_000);
    ensureReviewRunSchema(second);

    assert.deepEqual(
      second.prepare(`
        SELECT id, status, judgment_owner_id AS owner
        FROM review_runs ORDER BY id
      `).all(),
      [
        { id: 1, status: "cancelled", owner: null },
        { id: 2, status: "extracting", owner: "worker-live" },
      ],
    );
    const columns = second.prepare(
      "PRAGMA table_info(review_runs)",
    ).all() as Array<{ name: string }>;
    assert.ok(columns.some(({ name }) => name === "judgment_owner_id"));
    assert.ok(
      columns.some(({ name }) => name === "judgment_lease_expires_at_ms"),
    );
  } finally {
    first.close();
    second.close();
    removeDatabase(dbPath);
  }
});
