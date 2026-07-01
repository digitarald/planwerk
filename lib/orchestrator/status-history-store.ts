import "server-only";

import { getDb } from "@/lib/db/schema";
import { StatusEntry } from "@/lib/types";

/** Keep at most this many status rows per card; older rows are pruned on write. */
const MAX_ROWS_PER_CARD = 20;

/** Generic placeholder statuses that carry no real progress signal (e.g. the
 *  "Thinking" fallback used when a running session reports no activity). These
 *  are never recorded into history so the trail stays meaningful. Compared
 *  case-insensitively against the trimmed message. */
const IGNORED_STATUSES: ReadonlySet<string> = new Set(["thinking"]);

interface StatusRow {
  message: string;
  recorded_at: string;
}

/** SQLite `datetime('now')` yields a UTC string without a timezone marker.
 *  Append `Z` so Date parses it as UTC, then return epoch ms. */
function parseRecordedAt(recordedAt: string): number {
  const normalized = recordedAt.includes("T")
    ? recordedAt
    : recordedAt.replace(" ", "T");
  const ms = Date.parse(`${normalized}Z`);
  return Number.isNaN(ms) ? Date.now() : ms;
}

/**
 * Record a new status (activity) line for a card.
 * No-ops on empty/whitespace messages, on generic placeholder statuses (see
 * IGNORED_STATUSES), and when the message is identical to the card's most recent
 * entry (dedupes consecutive repeats). Prunes to the last MAX_ROWS_PER_CARD rows
 * after inserting.
 */
export function recordCardStatus(cardId: string, message: string): void {
  const trimmed = message.trim();
  if (!trimmed) return;
  if (IGNORED_STATUSES.has(trimmed.toLowerCase())) return;

  const db = getDb();

  const last = db
    .prepare(
      "SELECT message FROM card_status_history WHERE card_id = ? ORDER BY id DESC LIMIT 1"
    )
    .get(cardId) as { message: string } | undefined;

  if (last?.message === trimmed) return;

  db.prepare(
    "INSERT INTO card_status_history (card_id, message) VALUES (?, ?)"
  ).run(cardId, trimmed);

  db.prepare(
    `DELETE FROM card_status_history
     WHERE card_id = ?
       AND id NOT IN (
         SELECT id FROM card_status_history
         WHERE card_id = ?
         ORDER BY id DESC
         LIMIT ?
       )`
  ).run(cardId, cardId, MAX_ROWS_PER_CARD);
}

/**
 * Return the most recent status entries for a card in chronological order
 * (oldest→newest). `limit` caps how many trailing entries are returned.
 */
export function getCardStatusHistory(cardId: string, limit = 3): StatusEntry[] {
  const db = getDb();
  const rows = db
    .prepare(
      "SELECT message, recorded_at FROM card_status_history WHERE card_id = ? ORDER BY id DESC LIMIT ?"
    )
    .all(cardId, limit) as StatusRow[];

  return rows
    .map((row) => ({
      message: row.message,
      timestamp: parseRecordedAt(row.recorded_at),
    }))
    .reverse();
}
