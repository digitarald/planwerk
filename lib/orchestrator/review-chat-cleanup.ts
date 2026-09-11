import { randomUUID } from "node:crypto";

import type Database from "better-sqlite3";
import { normalizeReviewChatCleanupHostUrl } from "../db/review-chat-cleanup-schema.ts";

export type PeerChatDisposer = (
  hostUrl: string,
  chatUri: string,
) => Promise<void>;

const MAX_CLEANUP_ATTEMPTS = 3;
const CLEANUP_LEASE_MS = 30_000;

interface CleanupScheduler {
  set(callback: () => void, delayMs: number): unknown;
  clear(handle: unknown): void;
}

const defaultScheduler: CleanupScheduler = {
  set(callback, delayMs) {
    const timer = setInterval(callback, delayMs);
    timer.unref();
    return timer;
  },
  clear(handle) {
    clearInterval(handle as ReturnType<typeof setInterval>);
  },
};

export interface ReviewChatCleanupClaimOptions {
  ownerId?: string;
  now?: () => number;
  leaseMs?: number;
  scheduler?: CleanupScheduler;
}

export function recordReviewPeerChatCleanup(
  db: Database.Database,
  hostUrl: string,
  reviewRunId: number,
  chatUri: string,
  initialFailure?: {
    error: unknown;
    attempts?: number;
  },
): void {
  const attempts = Math.min(
    Math.max(initialFailure?.attempts ?? 0, 0),
    MAX_CLEANUP_ATTEMPTS,
  );
  const status = initialFailure ? "error" : "pending";
  const detail = initialFailure
    ? initialFailure.error instanceof Error
      ? initialFailure.error.message
      : String(initialFailure.error)
    : null;
  const normalizedHostUrl = normalizeReviewChatCleanupHostUrl(hostUrl);
  db.prepare(`
    INSERT INTO review_chat_cleanups (
      host_url, chat_uri, review_run_id, status, error, attempts,
      last_attempt_at
    )
    VALUES (?, ?, ?, ?, ?, ?, CASE WHEN ? > 0 THEN datetime('now') END)
    ON CONFLICT(host_url, chat_uri) DO NOTHING
  `).run(
    normalizedHostUrl,
    chatUri,
    reviewRunId,
    status,
    detail,
    attempts,
    attempts,
  );
}

export function recordReviewDispatchCommitLoss(
  db: Database.Database,
  input: {
    hostUrl: string;
    reviewRunId: number;
    chatUri: string;
    turnId: string | null;
    diagnostic: string;
    disposablePeerChat: boolean;
    initialFailure?: {
      error: unknown;
      attempts: number;
    };
  },
): void {
  const hostUrl = normalizeReviewChatCleanupHostUrl(input.hostUrl);
  const attempts = Math.min(
    Math.max(input.initialFailure?.attempts ?? 0, 0),
    MAX_CLEANUP_ATTEMPTS,
  );
  const error = input.initialFailure
    ? input.initialFailure.error instanceof Error
      ? input.initialFailure.error.message
      : String(input.initialFailure.error)
    : input.disposablePeerChat
      ? null
      : input.diagnostic;
  const status = input.disposablePeerChat
    ? input.initialFailure
      ? "error"
      : "pending"
    : "quarantined";
  db.prepare(`
    INSERT INTO review_chat_cleanups (
      host_url, chat_uri, turn_id, review_run_id, status, error,
      dispatch_diagnostic, blocks_review_start, attempts, last_attempt_at
    )
    VALUES (
      ?, ?, ?, ?, ?, ?, ?, 1, ?,
      CASE WHEN ? > 0 THEN datetime('now') END
    )
    ON CONFLICT(host_url, chat_uri) DO UPDATE SET
      turn_id = COALESCE(review_chat_cleanups.turn_id, excluded.turn_id),
      dispatch_diagnostic = COALESCE(
        review_chat_cleanups.dispatch_diagnostic,
        excluded.dispatch_diagnostic
      ),
      error = COALESCE(review_chat_cleanups.error, excluded.error),
      attempts = MAX(review_chat_cleanups.attempts, excluded.attempts),
      blocks_review_start = CASE
        WHEN review_chat_cleanups.status = 'completed' THEN 0
        ELSE 1
      END,
      updated_at = datetime('now')
  `).run(
    hostUrl,
    input.chatUri,
    input.turnId,
    input.reviewRunId,
    status,
    error,
    input.diagnostic,
    attempts,
    attempts,
  );
}

export async function attemptReviewPeerChatCleanup(
  db: Database.Database,
  hostUrl: string,
  reviewRunId: number,
  chatUri: string,
  disposer: PeerChatDisposer,
  options: ReviewChatCleanupClaimOptions = {},
): Promise<boolean> {
  const normalizedHostUrl = normalizeReviewChatCleanupHostUrl(hostUrl);
  recordReviewPeerChatCleanup(db, normalizedHostUrl, reviewRunId, chatUri);
  const ownerId = options.ownerId ?? randomUUID();
  const now = options.now ?? Date.now;
  const leaseMs = options.leaseMs ?? CLEANUP_LEASE_MS;
  const claimedAt = now();
  const row = db.prepare(`
    UPDATE review_chat_cleanups
    SET status = 'in_progress',
        claim_owner = ?,
        lease_expires_at_ms = ?,
        attempts = attempts + 1,
        last_attempt_at = datetime('now'),
        updated_at = datetime('now')
    WHERE host_url = ?
      AND chat_uri = ?
      AND attempts < ?
      AND (
        status IN ('pending', 'error')
        OR (
          status = 'in_progress'
          AND COALESCE(lease_expires_at_ms, 0) <= ?
        )
      )
    RETURNING attempts, host_url, chat_uri
  `).get(
    ownerId,
    claimedAt + leaseMs,
    normalizedHostUrl,
    chatUri,
    MAX_CLEANUP_ATTEMPTS,
    claimedAt,
  ) as {
    attempts: number;
    host_url: string;
    chat_uri: string;
  } | undefined;
  if (!row) return false;

  const attempt = row.attempts;
  const scheduler = options.scheduler ?? defaultScheduler;
  let leaseLost = false;
  const renewalTimer = scheduler.set(() => {
    const renewedAt = now();
    try {
      const renewed = db.prepare(`
        UPDATE review_chat_cleanups
        SET lease_expires_at_ms = ?, updated_at = datetime('now')
        WHERE host_url = ? AND chat_uri = ? AND status = 'in_progress'
          AND claim_owner = ? AND lease_expires_at_ms > ?
      `).run(
        renewedAt + leaseMs,
        row.host_url,
        row.chat_uri,
        ownerId,
        renewedAt,
      );
      if (renewed.changes !== 1) leaseLost = true;
    } catch {
      leaseLost = true;
    }
  }, Math.max(1, Math.floor(leaseMs / 3)));

  try {
    try {
      await disposer(row.host_url, row.chat_uri);
      if (leaseLost) return false;
      const completedAt = now();
      const completed = db.prepare(`
        UPDATE review_chat_cleanups
        SET status = 'completed', error = NULL, claim_owner = NULL,
          lease_expires_at_ms = NULL, blocks_review_start = 0,
          updated_at = datetime('now')
        WHERE host_url = ? AND chat_uri = ? AND status = 'in_progress'
          AND claim_owner = ? AND lease_expires_at_ms > ?
      `).run(row.host_url, row.chat_uri, ownerId, completedAt);
      return completed.changes === 1;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const failedAt = now();
      const failed = db.prepare(`
        UPDATE review_chat_cleanups
        SET status = 'error', error = ?, claim_owner = NULL,
          lease_expires_at_ms = NULL, updated_at = datetime('now')
        WHERE host_url = ? AND chat_uri = ? AND status = 'in_progress'
          AND claim_owner = ? AND lease_expires_at_ms > ?
      `).run(detail, row.host_url, row.chat_uri, ownerId, failedAt);
      if (failed.changes === 1) {
        console.warn(
          `[review-executor] Peer-chat cleanup failed for review run ${reviewRunId} ` +
            `(attempt ${attempt}/${MAX_CLEANUP_ATTEMPTS}):`,
          detail,
        );
      }
      return false;
    }
  } finally {
    scheduler.clear(renewalTimer);
  }
}

export async function retryPendingReviewChatCleanup(
  db: Database.Database,
  disposer: PeerChatDisposer,
  options: ReviewChatCleanupClaimOptions = {},
): Promise<number> {
  const now = options.now ?? Date.now;
  const rows = db.prepare(`
    SELECT host_url, review_run_id, chat_uri
    FROM review_chat_cleanups
    WHERE host_url IS NOT NULL
      AND attempts < ?
      AND (
        status IN ('pending', 'error')
        OR (
          status = 'in_progress'
          AND COALESCE(lease_expires_at_ms, 0) <= ?
        )
      )
    ORDER BY host_url, created_at, chat_uri
  `).all(MAX_CLEANUP_ATTEMPTS, now()) as Array<{
    host_url: string;
    review_run_id: number;
    chat_uri: string;
  }>;
  let completed = 0;
  for (const row of rows) {
    if (await attemptReviewPeerChatCleanup(
      db,
      row.host_url,
      row.review_run_id,
      row.chat_uri,
      disposer,
      options,
    )) {
      completed++;
    }
  }
  return completed;
}
