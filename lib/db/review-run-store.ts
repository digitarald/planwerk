import type Database from "better-sqlite3";

import { normalizeChangesetRef } from "../types.ts";
import { ABANDONED_REVIEW_START_SUMMARY } from "./work-lease-schema.ts";

const ACTIVE_STATUS_SQL =
  "'pending', 'dispatching', 'injected', 'extracting', 'ambiguous'";

export interface ReviewStartClaim {
  state: "claimed" | "active" | "ambiguous" | "maxed";
  reviewRunId: number;
  iteration: number;
  status: string;
}

interface StartRow {
  id: number;
  iteration: number;
  status: string;
  start_lease_expires_at_ms?: number | null;
}

export function claimReviewStart(
  db: Database.Database,
  input: {
    cardId: string;
    skillId: string;
    phaseTransition: string;
    maxIterations: number;
    changesetRef?: string;
    ownerId: string;
    leaseMs: number;
    now?: number;
  },
): ReviewStartClaim {
  const claim = db.transaction((): ReviewStartClaim => {
    const now = input.now ?? Date.now();
    const abandoned = db.prepare(`
      SELECT id, gate_run_id
      FROM review_runs
      WHERE card_id = ? AND skill_id = ? AND phase_transition = ?
        AND status = 'pending'
        AND COALESCE(start_lease_expires_at_ms, 0) <= ?
      ORDER BY id DESC
      LIMIT 1
    `).get(
      input.cardId,
      input.skillId,
      input.phaseTransition,
      now,
    ) as { id: number; gate_run_id: number | null } | undefined;
    if (abandoned) {
      db.prepare(`
        UPDATE review_runs
        SET status = 'failed',
            verdict_summary = COALESCE(verdict_summary, ?),
            start_owner_id = NULL,
            start_lease_expires_at_ms = NULL
        WHERE id = ? AND status = 'pending'
          AND COALESCE(start_lease_expires_at_ms, 0) <= ?
      `).run(ABANDONED_REVIEW_START_SUMMARY, abandoned.id, now);
      if (abandoned.gate_run_id !== null) {
        db.prepare(`
          UPDATE gate_runs
          SET status = 'failed', output = ?, completed_at = datetime('now'),
              owner_id = NULL, lease_expires_at_ms = NULL
          WHERE id = ? AND status = 'running'
        `).run(ABANDONED_REVIEW_START_SUMMARY, abandoned.gate_run_id);
      }
    }

    const active = db.prepare(`
      SELECT id, iteration, status, start_lease_expires_at_ms
      FROM review_runs
      WHERE card_id = ? AND skill_id = ? AND phase_transition = ?
        AND status IN (${ACTIVE_STATUS_SQL})
      ORDER BY id DESC
      LIMIT 1
    `).get(
      input.cardId,
      input.skillId,
      input.phaseTransition,
    ) as StartRow | undefined;
    if (active) {
      return {
        state: (
          active.status === "ambiguous"
          || (
            active.status === "dispatching"
            && (active.start_lease_expires_at_ms ?? 0) <= now
          )
        ) ? "ambiguous" : "active",
        reviewRunId: active.id,
        iteration: active.iteration,
        status: active.status,
      };
    }

    const latest = db.prepare(`
      SELECT id, iteration, status, verdict_summary
      FROM review_runs
      WHERE card_id = ? AND skill_id = ? AND phase_transition = ?
      ORDER BY id DESC
      LIMIT 1
    `).get(
      input.cardId,
      input.skillId,
      input.phaseTransition,
    ) as (StartRow & { verdict_summary: string | null }) | undefined;

    if (latest?.status === "failed") {
      const iteration = latest.verdict_summary === ABANDONED_REVIEW_START_SUMMARY
        ? latest.iteration
        : latest.iteration + 1;
      if (iteration > input.maxIterations) {
        db.prepare(`
          UPDATE review_runs
          SET status = 'escalated',
              verdict_summary = 'Max iterations reached',
              judgment_owner_id = NULL,
              judgment_lease_expires_at_ms = NULL
          WHERE id = ? AND status = 'failed'
        `).run(latest.id);
        return {
          state: "maxed",
          reviewRunId: latest.id,
          iteration: latest.iteration,
          status: "escalated",
        };
      }

      const updated = db.prepare(`
        UPDATE review_runs
        SET status = 'pending',
            iteration = ?,
            max_iterations = ?,
            prompt_injected_at = NULL,
            verdict_extracted_at = NULL,
            verdict_summary = NULL,
            findings_json = NULL,
            gate_run_id = NULL,
            changeset_ref = ?,
            turn_id = NULL,
            chat_uri = NULL,
            judgment_owner_id = NULL,
            judgment_lease_expires_at_ms = NULL,
            start_owner_id = ?,
            start_lease_expires_at_ms = ?,
            dispatch_host_url = NULL,
            dispatch_chat_disposable = NULL
        WHERE id = ? AND status = 'failed'
      `).run(
        iteration,
        input.maxIterations,
        input.changesetRef ?? null,
        input.ownerId,
        now + input.leaseMs,
        latest.id,
      );
      if (updated.changes !== 1) {
        throw new Error("Review start claim changed while transaction was active.");
      }
      return {
        state: "claimed",
        reviewRunId: latest.id,
        iteration,
        status: "pending",
      };
    }

    const inserted = db.prepare(`
      INSERT INTO review_runs (
        card_id, skill_id, phase_transition, status, iteration,
        max_iterations, changeset_ref, start_owner_id,
        start_lease_expires_at_ms
      )
      VALUES (?, ?, ?, 'pending', 1, ?, ?, ?, ?)
    `).run(
      input.cardId,
      input.skillId,
      input.phaseTransition,
      input.maxIterations,
      input.changesetRef ?? null,
      input.ownerId,
      now + input.leaseMs,
    );
    return {
      state: "claimed",
      reviewRunId: Number(inserted.lastInsertRowid),
      iteration: 1,
      status: "pending",
    };
  });
  return claim.immediate();
}

export function linkOwnedReviewStartGate(
  db: Database.Database,
  reviewRunId: number,
  ownerId: string,
  gateRunId: number,
  now = Date.now(),
): boolean {
  return db.prepare(`
    UPDATE review_runs
    SET gate_run_id = ?
    WHERE id = ? AND status = 'pending'
      AND start_owner_id = ?
      AND start_lease_expires_at_ms > ?
  `).run(gateRunId, reviewRunId, ownerId, now).changes === 1;
}

export function renewReviewStartLease(
  db: Database.Database,
  reviewRunId: number,
  ownerId: string,
  leaseMs: number,
  now = Date.now(),
): boolean {
  const renew = db.transaction(() => {
    const row = db.prepare(`
      SELECT gate_run_id
      FROM review_runs
      WHERE id = ? AND status IN ('pending', 'dispatching')
        AND start_owner_id = ?
        AND start_lease_expires_at_ms > ?
    `).get(reviewRunId, ownerId, now) as {
      gate_run_id: number | null;
    } | undefined;
    if (!row) return false;
    if (row.gate_run_id !== null) {
      const gate = db.prepare(`
        UPDATE gate_runs
        SET lease_expires_at_ms = ?
        WHERE id = ? AND status = 'running' AND owner_id = ?
          AND lease_expires_at_ms > ?
      `).run(
        now + leaseMs,
        row.gate_run_id,
        ownerId,
        now,
      );
      if (gate.changes !== 1) return false;
    }
    return db.prepare(`
      UPDATE review_runs
      SET start_lease_expires_at_ms = ?
      WHERE id = ? AND status IN ('pending', 'dispatching')
        AND start_owner_id = ?
        AND start_lease_expires_at_ms > ?
    `).run(
      now + leaseMs,
      reviewRunId,
      ownerId,
      now,
    ).changes === 1;
  });
  return renew.immediate();
}

export function commitOwnedReviewDispatch(
  db: Database.Database,
  reviewRunId: number,
  ownerId: string,
  turnId: string | null,
  chatUri: string | null,
  now = Date.now(),
): boolean {
  return db.prepare(`
    UPDATE review_runs
    SET status = 'injected',
        prompt_injected_at = datetime('now'),
        turn_id = ?,
        chat_uri = ?,
        start_owner_id = NULL,
        start_lease_expires_at_ms = NULL
    WHERE id = ? AND status = 'dispatching'
      AND start_owner_id = ?
      AND start_lease_expires_at_ms > ?
  `).run(
    turnId,
    chatUri,
    reviewRunId,
    ownerId,
    now,
  ).changes === 1;
}

export interface JudgmentClaimRow {
  id: number;
  card_id: string;
  skill_id: string;
  phase_transition: string;
  status: string;
  iteration: number;
  max_iterations: number;
  prompt_injected_at: string | null;
  verdict_extracted_at: string | null;
  verdict_summary: string | null;
  findings_json: string | null;
  gate_run_id: number | null;
  changeset_ref: string | null;
  turn_id: string | null;
  chat_uri: string | null;
  chat_cleanup_status: "pending" | "completed" | "error" | null;
  chat_cleanup_error: string | null;
  chat_cleanup_attempts: number;
  chat_cleanup_last_attempt_at: string | null;
}

export function claimReviewJudgment(
  db: Database.Database,
  reviewRunId: number,
  ownerId: string,
  leaseMs: number,
  now = Date.now(),
): JudgmentClaimRow | null {
  return (db.prepare(`
    UPDATE review_runs
    SET status = 'extracting',
        judgment_owner_id = ?,
        judgment_lease_expires_at_ms = ?
    WHERE id = ?
      AND (
        status = 'injected'
        OR (
          status = 'extracting'
          AND COALESCE(judgment_lease_expires_at_ms, 0) <= ?
        )
      )
    RETURNING *
  `).get(
    ownerId,
    now + leaseMs,
    reviewRunId,
    now,
  ) as JudgmentClaimRow | undefined) ?? null;
}

export function renewReviewJudgmentLease(
  db: Database.Database,
  reviewRunId: number,
  ownerId: string,
  leaseMs: number,
  now = Date.now(),
): boolean {
  return db.prepare(`
    UPDATE review_runs
    SET judgment_lease_expires_at_ms = ?
    WHERE id = ?
      AND status = 'extracting'
      AND judgment_owner_id = ?
      AND judgment_lease_expires_at_ms > ?
  `).run(
    now + leaseMs,
    reviewRunId,
    ownerId,
    now,
  ).changes === 1;
}

function completeOwnedGate(
  db: Database.Database,
  input: {
    gateRunId: number | null;
    reviewRunId: number;
    ownerId: string;
    reviewStatus: string;
    gateStatus: "passed" | "failed";
    gateOutput: string;
  },
): boolean {
  if (input.gateRunId === null) return true;
  return db.prepare(`
    UPDATE gate_runs
    SET status = ?, output = ?, completed_at = datetime('now'),
        owner_id = NULL, lease_expires_at_ms = NULL
    WHERE id = ?
      AND EXISTS (
        SELECT 1
        FROM review_runs
        WHERE id = ?
          AND judgment_owner_id = ?
          AND status = ?
      )
  `).run(
    input.gateStatus,
    input.gateOutput,
    input.gateRunId,
    input.reviewRunId,
    input.ownerId,
    input.reviewStatus,
  ).changes === 1;
}

export interface OwnedReviewOutcome {
  reviewStatus: "passed" | "failed" | "escalated";
  verdictSummary: string;
  findings: string[];
  gateStatus: "passed" | "failed";
  gateOutput: string;
  verdictExtracted?: boolean;
}

export function commitOwnedReviewOutcome(
  db: Database.Database,
  reviewRunId: number,
  ownerId: string,
  outcome: OwnedReviewOutcome,
  now = Date.now(),
): boolean {
  const commit = db.transaction(() => {
    const row = db.prepare(`
      SELECT gate_run_id
      FROM review_runs
      WHERE id = ?
        AND status = 'extracting'
        AND judgment_owner_id = ?
        AND judgment_lease_expires_at_ms > ?
    `).get(reviewRunId, ownerId, now) as {
      gate_run_id: number | null;
    } | undefined;
    if (!row) return false;

    const updated = db.prepare(`
      UPDATE review_runs
      SET status = ?,
          verdict_extracted_at = CASE WHEN ? THEN datetime('now') END,
          verdict_summary = ?,
          findings_json = ?,
          judgment_lease_expires_at_ms = NULL
      WHERE id = ?
        AND status = 'extracting'
        AND judgment_owner_id = ?
        AND judgment_lease_expires_at_ms > ?
    `).run(
      outcome.reviewStatus,
      outcome.verdictExtracted === false ? 0 : 1,
      outcome.verdictSummary,
      JSON.stringify(outcome.findings),
      reviewRunId,
      ownerId,
      now,
    );
    if (updated.changes !== 1) return false;

    if (!completeOwnedGate(db, {
      gateRunId: row.gate_run_id,
      reviewRunId,
      ownerId,
      reviewStatus: outcome.reviewStatus,
      gateStatus: outcome.gateStatus,
      gateOutput: outcome.gateOutput,
    })) {
      throw new Error("Owned review gate could not be completed.");
    }
    return true;
  });
  try {
    return commit.immediate();
  } catch (error) {
    if (
      error instanceof Error
      && error.message === "Owned review gate could not be completed."
    ) {
      return false;
    }
    throw error;
  }
}

export type ReviewFreshnessResult = "current" | "stale" | "lost";

export function failOwnedReviewIfSourceChanged(
  db: Database.Database,
  reviewRunId: number,
  ownerId: string,
  currentChangesetRef?: string,
  now = Date.now(),
): ReviewFreshnessResult {
  const current = normalizeChangesetRef(currentChangesetRef);

  const row = db.prepare(`
    SELECT changeset_ref
    FROM review_runs
    WHERE id = ?
      AND status = 'extracting'
      AND judgment_owner_id = ?
      AND judgment_lease_expires_at_ms > ?
  `).get(reviewRunId, ownerId, now) as {
    changeset_ref: string | null;
  } | undefined;
  if (!row) return "lost";
  const reviewed = normalizeChangesetRef(row.changeset_ref ?? undefined);
  if (current !== "" && reviewed !== "" && reviewed === current) {
    return "current";
  }

  const summary = current === ""
    ? "Review evidence cannot be accepted because the current source revision is unavailable."
    : "Review evidence is stale because the source changed after dispatch; re-review required.";
  const committed = commitOwnedReviewOutcome(
    db,
    reviewRunId,
    ownerId,
    {
      reviewStatus: "failed",
      verdictSummary: summary,
      findings: [],
      gateStatus: "failed",
      gateOutput: summary,
      verdictExtracted: false,
    },
    now,
  );
  return committed ? "stale" : "lost";
}
