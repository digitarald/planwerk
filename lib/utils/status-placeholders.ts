/** Generic placeholder status lines that carry no real progress signal — e.g.
 *  the "Thinking" fallback shown when a running session reports no activity.
 *  These are never recorded into status history and are hidden from the card
 *  trail so the progress trail stays meaningful. Shared by the server-side
 *  recorder and the client-side card so the rule lives in one place. */
const GENERIC_STATUSES: ReadonlySet<string> = new Set(["thinking"]);

/** Whether a status line is a generic placeholder (case-insensitive, trimmed). */
export function isGenericStatus(message: string | undefined | null): boolean {
  if (!message) return false;
  return GENERIC_STATUSES.has(message.trim().toLowerCase());
}
