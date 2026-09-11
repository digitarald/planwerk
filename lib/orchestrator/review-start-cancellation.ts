import type Database from "better-sqlite3";

export function terminalizeCancelledReviewStart(
  db: Database.Database,
  reviewRunId: number,
  gateRunId: number | undefined,
  completeGateRun: (
    runId: number,
    status: "passed" | "failed",
    output?: string,
  ) => void,
  ownership?: { ownerId: string; now?: number },
): boolean {
  const result = ownership
    ? db.prepare(`
        UPDATE review_runs
        SET status = 'cancelled', verdict_summary = ?,
            start_lease_expires_at_ms = NULL
        WHERE id = ? AND status = 'pending'
          AND start_owner_id = ?
          AND start_lease_expires_at_ms > ?
      `).run(
        "Review start was cancelled before prompt dispatch.",
        reviewRunId,
        ownership.ownerId,
        ownership.now ?? Date.now(),
      )
    : db.prepare(
        "UPDATE review_runs SET status = 'cancelled', verdict_summary = ? WHERE id = ?",
      ).run("Review start was cancelled before prompt dispatch.", reviewRunId);
  if (result.changes === 1 && gateRunId !== undefined) {
    completeGateRun(
      gateRunId,
      "failed",
      "Cancelled before the review prompt was dispatched.",
    );
  }
  return result.changes === 1;
}
