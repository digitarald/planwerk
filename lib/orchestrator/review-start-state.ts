import type Database from "better-sqlite3";

import { MessageDispatchAmbiguousError } from "../ahp/dispatch-confirmation.ts";
import { PeerChatCleanupRequiredError } from "../ahp/peer-review-dispatch.ts";
import { commitOwnedReviewDispatch } from "../db/review-run-store.ts";
import { AMBIGUOUS_REVIEW_DISPATCH_SUMMARY } from "../db/work-lease-schema.ts";
import { normalizeChangesetRef } from "../types.ts";
import {
  recordReviewDispatchCommitLoss,
  recordReviewPeerChatCleanup,
} from "./review-chat-cleanup.ts";

export interface ReviewStartState {
  status: string;
  changesetRef: string | null;
}

const DISPATCH_COMMIT_LOST_DIAGNOSTIC =
  "Review prompt dispatch succeeded, but its owner lease was lost before the dispatch identity could be committed.";

interface DispatchingReviewRow {
  id: number;
  gate_run_id: number | null;
  start_owner_id: string | null;
  start_lease_expires_at_ms: number | null;
  dispatch_host_url: string | null;
  dispatch_chat_disposable: number | null;
  chat_uri: string | null;
  turn_id: string | null;
}

function failDispatchGate(
  database: Database.Database,
  gateRunId: number | null,
  summary: string,
  ownerId?: string | null,
): void {
  if (gateRunId === null) return;
  database.prepare(`
    UPDATE gate_runs
    SET status = 'failed', output = ?, completed_at = datetime('now'),
        owner_id = NULL, lease_expires_at_ms = NULL
    WHERE id = ? AND status = 'running'
      AND (? IS NULL OR owner_id = ?)
  `).run(summary, gateRunId, ownerId ?? null, ownerId ?? null);
}

function queueDispatchReconciliation(
  database: Database.Database,
  row: DispatchingReviewRow,
  summary: string,
): void {
  if (!row.dispatch_host_url || !row.chat_uri) return;
  recordReviewDispatchCommitLoss(database, {
    hostUrl: row.dispatch_host_url,
    reviewRunId: row.id,
    chatUri: row.chat_uri,
    turnId: row.turn_id,
    diagnostic: summary,
    disposablePeerChat: row.dispatch_chat_disposable === 1,
  });
}

export function finalizeOwnedReviewDispatch(
  database: Database.Database,
  input: {
    hostUrl: string;
    reviewRunId: number;
    ownerId: string;
    turnId: string | null;
    chatUri: string | null;
    disposablePeerChat: boolean;
    now?: number;
  },
): { state: "committed" | "orphaned"; summary?: string } {
  const persist = (diagnostic: string) => {
    if (input.chatUri) {
      recordReviewDispatchCommitLoss(database, {
        hostUrl: input.hostUrl,
        reviewRunId: input.reviewRunId,
        chatUri: input.chatUri,
        turnId: input.turnId,
        diagnostic,
        disposablePeerChat: input.disposablePeerChat,
      });
    }
    const row = database.prepare(`
      SELECT gate_run_id
      FROM review_runs
      WHERE id = ? AND status = 'dispatching'
        AND start_owner_id = ?
        AND chat_uri IS ?
    `).get(
      input.reviewRunId,
      input.ownerId,
      input.chatUri,
    ) as { gate_run_id: number | null } | undefined;
    if (row) {
      const updated = database.prepare(`
        UPDATE review_runs
        SET status = 'ambiguous', verdict_summary = ?,
            start_owner_id = NULL, start_lease_expires_at_ms = NULL
        WHERE id = ? AND status = 'dispatching'
          AND start_owner_id = ?
          AND chat_uri IS ?
      `).run(
        diagnostic,
        input.reviewRunId,
        input.ownerId,
        input.chatUri,
      );
      if (updated.changes === 1) {
        failDispatchGate(
          database,
          row.gate_run_id,
          diagnostic,
          input.ownerId,
        );
      }
    }
    return {
      state: "orphaned" as const,
      summary: input.chatUri
        ? diagnostic
        : `${diagnostic} The dispatched chat identity was unavailable.`,
    };
  };
  const finalize = database.transaction(() => {
    if (commitOwnedReviewDispatch(
      database,
      input.reviewRunId,
      input.ownerId,
      input.turnId,
      input.chatUri,
      input.now,
    )) {
      return { state: "committed" as const };
    }
    return persist(DISPATCH_COMMIT_LOST_DIAGNOSTIC);
  });
  try {
    return finalize.immediate();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return persist(
      `${DISPATCH_COMMIT_LOST_DIAGNOSTIC} Commit error: ${detail}`,
    );
  }
}

interface BlockingDispatchRow {
  review_run_id: number;
  chat_uri: string;
  turn_id: string | null;
  dispatch_diagnostic: string | null;
}

function blockingDispatchForReview(
  database: Database.Database,
  reviewRunId: number,
): BlockingDispatchRow | undefined {
  return database.prepare(`
    SELECT review_run_id, chat_uri, turn_id, dispatch_diagnostic
    FROM review_chat_cleanups
    WHERE review_run_id = ? AND blocks_review_start = 1
    ORDER BY created_at, chat_uri
    LIMIT 1
  `).get(reviewRunId) as BlockingDispatchRow | undefined;
}

function ambiguitySummary(row: BlockingDispatchRow): string {
  return row.dispatch_diagnostic ?? DISPATCH_COMMIT_LOST_DIAGNOSTIC;
}

export function reconcileRecoveredReviewDispatch(
  database: Database.Database,
  input: {
    cardId: string;
    skillId: string;
    phaseTransition: string;
    now?: number;
  },
): { reviewRunId: number; summary: string } | null {
  const reconcile = database.transaction(() => {
    const now = input.now ?? Date.now();
    const dispatching = database.prepare(`
      SELECT id, gate_run_id, start_owner_id, start_lease_expires_at_ms,
        dispatch_host_url, dispatch_chat_disposable, chat_uri, turn_id
      FROM review_runs
      WHERE card_id = ? AND skill_id = ? AND phase_transition = ?
        AND status = 'dispatching'
        AND COALESCE(start_lease_expires_at_ms, 0) <= ?
      ORDER BY id DESC
      LIMIT 1
    `).get(
      input.cardId,
      input.skillId,
      input.phaseTransition,
      now,
    ) as DispatchingReviewRow | undefined;
    if (dispatching) {
      const updated = database.prepare(`
        UPDATE review_runs
        SET status = 'ambiguous', verdict_summary = ?,
            start_owner_id = NULL, start_lease_expires_at_ms = NULL
        WHERE id = ? AND status = 'dispatching'
          AND COALESCE(start_lease_expires_at_ms, 0) <= ?
      `).run(AMBIGUOUS_REVIEW_DISPATCH_SUMMARY, dispatching.id, now);
      if (updated.changes !== 1) return null;
      queueDispatchReconciliation(
        database,
        dispatching,
        AMBIGUOUS_REVIEW_DISPATCH_SUMMARY,
      );
      failDispatchGate(
        database,
        dispatching.gate_run_id,
        AMBIGUOUS_REVIEW_DISPATCH_SUMMARY,
        dispatching.start_owner_id,
      );
      return {
        reviewRunId: dispatching.id,
        summary: AMBIGUOUS_REVIEW_DISPATCH_SUMMARY,
      };
    }

    const row = database.prepare(`
      SELECT review_runs.id, review_runs.gate_run_id,
        review_runs.status, review_runs.start_lease_expires_at_ms
      FROM review_runs
      WHERE review_runs.card_id = ?
        AND review_runs.skill_id = ?
        AND review_runs.phase_transition = ?
        AND review_runs.status IN ('pending', 'failed')
        AND EXISTS (
          SELECT 1 FROM review_chat_cleanups
          WHERE review_chat_cleanups.review_run_id = review_runs.id
            AND review_chat_cleanups.blocks_review_start = 1
        )
      ORDER BY review_runs.id DESC
      LIMIT 1
    `).get(
      input.cardId,
      input.skillId,
      input.phaseTransition,
    ) as {
      id: number;
      gate_run_id: number | null;
      status: string;
      start_lease_expires_at_ms: number | null;
    } | undefined;
    if (!row) return null;
    if (
      row.status === "pending"
      && (row.start_lease_expires_at_ms ?? 0) > now
    ) {
      return null;
    }
    const dispatch = blockingDispatchForReview(database, row.id);
    if (!dispatch) return null;
    const summary = ambiguitySummary(dispatch);
    const updated = database.prepare(`
      UPDATE review_runs
      SET status = 'ambiguous', verdict_summary = ?,
          chat_uri = ?, turn_id = ?,
          start_owner_id = NULL, start_lease_expires_at_ms = NULL
      WHERE id = ? AND status = ?
    `).run(summary, dispatch.chat_uri, dispatch.turn_id, row.id, row.status);
    if (updated.changes !== 1) return null;
    if (row.gate_run_id !== null) {
      database.prepare(`
        UPDATE gate_runs
        SET status = 'failed', output = ?, completed_at = datetime('now'),
            owner_id = NULL, lease_expires_at_ms = NULL
        WHERE id = ? AND status = 'running'
      `).run(summary, row.gate_run_id);
    }
    return { reviewRunId: row.id, summary };
  });
  return reconcile.immediate();
}

export function prepareOwnedReviewDispatch(
  database: Database.Database,
  input: {
    reviewRunId: number;
    ownerId: string;
    hostUrl: string;
    chatUri: string;
    turnId: string;
    disposablePeerChat: boolean;
    planSourceJson?: string;
    sourceDigest?: string;
    now?: number;
  },
): { state: "ready" | "lost" | "blocked"; summary?: string } {
  const prepare = database.transaction(() => {
    const now = input.now ?? Date.now();
    const owned = database.prepare(`
      SELECT gate_run_id
      FROM review_runs
      WHERE id = ? AND status = 'pending'
        AND start_owner_id = ?
        AND start_lease_expires_at_ms > ?
    `).get(input.reviewRunId, input.ownerId, now) as {
      gate_run_id: number | null;
    } | undefined;
    if (!owned) return { state: "lost" as const };

    const dispatch = blockingDispatchForReview(database, input.reviewRunId);
    if (!dispatch) {
      const reserved = database.prepare(`
        UPDATE review_runs
        SET status = 'dispatching',
            chat_uri = ?,
            turn_id = ?,
            dispatch_host_url = ?,
            dispatch_chat_disposable = ?,
            plan_source_json = ?,
            source_digest = ?
        WHERE id = ? AND status = 'pending'
          AND start_owner_id = ?
          AND start_lease_expires_at_ms > ?
      `).run(
        input.chatUri,
        input.turnId,
        new URL(input.hostUrl).href,
        input.disposablePeerChat ? 1 : 0,
        input.planSourceJson ?? null,
        input.sourceDigest ?? null,
        input.reviewRunId,
        input.ownerId,
        now,
      );
      return reserved.changes === 1
        ? { state: "ready" as const }
        : { state: "lost" as const };
    }
    const summary = ambiguitySummary(dispatch);
    const updated = database.prepare(`
      UPDATE review_runs
      SET status = 'ambiguous', verdict_summary = ?,
          chat_uri = ?, turn_id = ?,
          start_owner_id = NULL, start_lease_expires_at_ms = NULL
      WHERE id = ? AND status = 'pending'
        AND start_owner_id = ?
        AND start_lease_expires_at_ms > ?
    `).run(
      summary,
      dispatch.chat_uri,
      dispatch.turn_id,
      input.reviewRunId,
      input.ownerId,
      now,
    );
    if (updated.changes !== 1) return { state: "lost" as const };
    if (owned.gate_run_id !== null) {
      database.prepare(`
        UPDATE gate_runs
        SET status = 'failed', output = ?, completed_at = datetime('now'),
            owner_id = NULL, lease_expires_at_ms = NULL
        WHERE id = ? AND status = 'running' AND owner_id = ?
      `).run(summary, owned.gate_run_id, input.ownerId);
    }
    return { state: "blocked" as const, summary };
  });
  return prepare.immediate();
}

export function shouldStartReviewForRun(
  latest: ReviewStartState | null,
  currentChangesetRef?: string,
): boolean {
  const current = normalizeChangesetRef(currentChangesetRef);
  if (current === "") return false;
  if (!latest) return true;
  if (latest.status === "dispatching" || latest.status === "ambiguous") {
    return false;
  }
  const terminal = latest.status === "passed" || latest.status === "escalated";
  if (!terminal) return true;
  const reviewed = normalizeChangesetRef(latest.changesetRef ?? undefined);
  return reviewed === "" || reviewed !== current;
}

function describeReviewStartError(error: unknown): string {
  const primary = error instanceof Error ? error.message : String(error);
  if (
    (
      error instanceof MessageDispatchAmbiguousError
      || error instanceof PeerChatCleanupRequiredError
    )
    && error.cleanupError !== undefined
  ) {
    const cleanup = error.cleanupError instanceof Error
      ? error.cleanupError.message
      : String(error.cleanupError);
    return `${primary} Peer chat cleanup failed: ${cleanup}`;
  }
  return primary;
}

export function persistReviewStartFailure(
  database: Database.Database,
  hostUrl: string,
  reviewRunId: number,
  failure: unknown,
  ownership?: { ownerId: string; now?: number },
): {
  status: "failed" | "ambiguous";
  disposition: "retryable" | "needs-human";
  summary: string;
  applied: boolean;
} {
  const reservation = database.prepare(`
    SELECT dispatch_host_url, dispatch_chat_disposable, chat_uri, turn_id
    FROM review_runs
    WHERE id = ?
  `).get(reviewRunId) as {
    dispatch_host_url: string | null;
    dispatch_chat_disposable: number | null;
    chat_uri: string | null;
    turn_id: string | null;
  } | undefined;
  const cleanupRequired = failure instanceof PeerChatCleanupRequiredError
    ? failure
    : null;
  const cleanupIdentity = cleanupRequired
    ?? (
      failure instanceof MessageDispatchAmbiguousError
      && failure.chatUri
      && failure.cleanupError !== undefined
        ? {
            chatUri: failure.chatUri,
            cleanupError: failure.cleanupError,
            cleanupAttempts: 1,
          }
        : null
    );
  const ambiguous = failure instanceof MessageDispatchAmbiguousError
    || cleanupRequired?.dispatchAmbiguous === true;
  const status = ambiguous ? "ambiguous" : "failed";
  const disposition = ambiguous ? "needs-human" : "retryable";
  const summary = `Injection error: ${describeReviewStartError(failure)}`;
  const failureChatUri = failure instanceof MessageDispatchAmbiguousError
    || failure instanceof PeerChatCleanupRequiredError
    ? failure.chatUri ?? null
    : null;
  const failureTurnId = failure instanceof MessageDispatchAmbiguousError
    || failure instanceof PeerChatCleanupRequiredError
    ? failure.turnId ?? null
    : null;
  const chatUri = failureChatUri ?? reservation?.chat_uri ?? null;
  const turnId = failureTurnId ?? reservation?.turn_id ?? null;

  const applied = database.transaction(() => {
    if (ambiguous && chatUri) {
      recordReviewDispatchCommitLoss(database, {
        hostUrl: reservation?.dispatch_host_url ?? hostUrl,
        reviewRunId,
        chatUri,
        turnId,
        diagnostic: summary,
        disposablePeerChat:
          reservation?.dispatch_chat_disposable === 1
          || cleanupIdentity !== null,
        ...(cleanupIdentity
          ? {
              initialFailure: {
                error: cleanupIdentity.cleanupError,
                attempts: cleanupIdentity.cleanupAttempts,
              },
            }
          : {}),
      });
    } else if (cleanupIdentity) {
      recordReviewPeerChatCleanup(
        database,
        hostUrl,
        reviewRunId,
        cleanupIdentity.chatUri,
        {
          error: cleanupIdentity.cleanupError,
          attempts: cleanupIdentity.cleanupAttempts,
        },
      );
    }
    const updated = ownership
      ? database.prepare(
          `UPDATE review_runs
           SET status = ?, verdict_summary = ?, chat_uri = ?, turn_id = ?,
               start_owner_id = NULL, start_lease_expires_at_ms = NULL
           WHERE id = ? AND status IN ('pending', 'dispatching')
             AND start_owner_id = ?
             AND start_lease_expires_at_ms > ?`,
        ).run(
          status,
          summary,
          chatUri,
          turnId,
          reviewRunId,
          ownership.ownerId,
          ownership.now ?? Date.now(),
        )
      : database.prepare(
          `UPDATE review_runs
           SET status = ?, verdict_summary = ?, chat_uri = ?, turn_id = ?,
               start_owner_id = NULL, start_lease_expires_at_ms = NULL
           WHERE id = ?`,
        ).run(status, summary, chatUri, turnId, reviewRunId);
    return updated.changes === 1;
  })();

  return { status, disposition, summary, applied };
}
