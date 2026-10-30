export const INBOX_SOURCE_STALE_MS = 30 * 60 * 1_000;

export function inboxSourceFreshness(
  observedAt: number | undefined,
  connected: boolean,
  now: number,
): "current" | "stale" | "unverified" | "disconnected" {
  if (!connected) return "disconnected";
  if (observedAt === undefined || !Number.isFinite(observedAt)) return "unverified";
  return now - observedAt > INBOX_SOURCE_STALE_MS ? "stale" : "current";
}
