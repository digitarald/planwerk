import { AHPStatus } from "./types.ts";

/**
 * Session subscriptions are not passive reads: the VS Code Agent Host may
 * restore an evicted session and resume its provider. Only inspect sessions
 * that are already active; cold sessions stay catalog-only until they change
 * or Planwerk explicitly acts on them.
 */
export function shouldReadLiveSessionState(status: number): boolean {
  if ((status & AHPStatus.IsArchived) !== 0) return false;
  return (status & AHPStatus.InProgress) !== 0;
}

export function shouldEnrichSessionOnStartup(
  status: number,
  summaryUnchanged: boolean,
  hasCachedEnrichment: boolean,
): boolean {
  return (
    shouldReadLiveSessionState(status)
    && (!summaryUnchanged || !hasCachedEnrichment)
  );
}
