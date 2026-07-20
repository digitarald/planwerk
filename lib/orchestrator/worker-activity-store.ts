import "server-only";

import { getDb } from "@/lib/db/schema";
import type { StatusEntry } from "@/lib/types";
import { isGenericStatus } from "@/lib/utils/status-placeholders";

const MAX_ROWS_PER_WORKER = 12;

interface WorkerStatusRow {
  message: string;
  recorded_at: string;
}

function parseRecordedAt(recordedAt: string): number {
  const normalized = recordedAt.includes("T") ? recordedAt : recordedAt.replace(" ", "T");
  const timestamp = Date.parse(`${normalized}Z`);
  return Number.isNaN(timestamp) ? Date.now() : timestamp;
}

export function recordWorkerActivity(cardId: string, workerId: string, message: string | undefined): void {
  const trimmed = message?.trim();
  if (!trimmed || isGenericStatus(trimmed)) return;

  const db = getDb();
  const last = db.prepare(
    `SELECT message FROM worker_status_history
     WHERE card_id = ? AND worker_id = ?
     ORDER BY id DESC LIMIT 1`
  ).get(cardId, workerId) as { message: string } | undefined;
  if (last?.message === trimmed) return;

  db.prepare(
    "INSERT INTO worker_status_history (card_id, worker_id, message) VALUES (?, ?, ?)"
  ).run(cardId, workerId, trimmed);
  db.prepare(
    `DELETE FROM worker_status_history
     WHERE card_id = ? AND worker_id = ?
       AND id NOT IN (
         SELECT id FROM worker_status_history
         WHERE card_id = ? AND worker_id = ?
         ORDER BY id DESC LIMIT ?
       )`
  ).run(cardId, workerId, cardId, workerId, MAX_ROWS_PER_WORKER);
}

export function getWorkerActivityHistory(cardId: string, workerId: string, limit = MAX_ROWS_PER_WORKER): StatusEntry[] {
  const rows = getDb().prepare(
    `SELECT message, recorded_at FROM worker_status_history
     WHERE card_id = ? AND worker_id = ?
     ORDER BY id DESC LIMIT ?`
  ).all(cardId, workerId, limit) as WorkerStatusRow[];

  return rows.map((row) => ({
    message: row.message,
    timestamp: parseRecordedAt(row.recorded_at),
  })).reverse();
}
