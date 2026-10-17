import { AHPStatus } from "./types.ts";

/**
 * Session subscriptions are not passive reads: the VS Code Agent Host may
 * restore an evicted session and resume its provider. Only inspect sessions
 * that are already active; cold sessions stay catalog-only unless Planwerk
 * explicitly acts on them. A catalog timestamp is not evidence of activity.
 */
export function shouldReadLiveSessionState(status: number): boolean {
  if ((status & AHPStatus.IsArchived) !== 0) return false;
  return (status & AHPStatus.InProgress) !== 0;
}

/** One bounded final read for work we actually observed running, not idle churn. */
export function isSessionCompletion(previousStatus: number, status: number): boolean {
  return shouldReadLiveSessionState(previousStatus)
    && (status & AHPStatus.IsArchived) === 0
    && (status & AHPStatus.InProgress) === 0
    && (status & (AHPStatus.Idle | AHPStatus.Error)) !== 0;
}

export function shouldEnrichSessionOnChange(
  previousStatus: number,
  status: number,
  contentChanged: boolean,
  missingPlan: boolean,
): boolean {
  return isSessionCompletion(previousStatus, status)
    || (shouldReadLiveSessionState(status) && (
      !shouldReadLiveSessionState(previousStatus)
      || contentChanged
      || ((status & AHPStatus.InputNeeded) === AHPStatus.InputNeeded && missingPlan)
    ));
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
