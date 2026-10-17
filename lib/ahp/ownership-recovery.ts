import "server-only";

import { awaitAbortable, throwIfAborted } from "../abort.ts";
import { getDb } from "../db/schema";
import {
  hasOwnershipRecoveryInFlight,
  recoverSessionOwnership,
  type OwnershipRecoveryResult,
} from "../db/ownership-recovery.ts";
import { getSessionOwnership, resolveSessionOwnershipHost } from "../db/session-ownership.ts";
import { listAllSessions } from "./catalog";
import { withAHPClient } from "./client-operation";
import { mapSdkSessionSummary } from "./session-summary";
import { attachAHPSourceRevision, publishOwnershipRecovery } from "./source-binding";

export interface RecoverSessionOwnershipInput {
  sessionUri: string;
  hostId: string;
  expectedRevision: number;
  confirm: boolean;
}

/** Recovery reads only the root catalog; it never subscribes to a live session. */
export async function rebindSessionOwnership(
  input: RecoverSessionOwnershipInput,
  signal?: AbortSignal,
): Promise<OwnershipRecoveryResult> {
  if (input.confirm !== true) return { success: false, reason: "confirmation-required" };
  const db = getDb();
  const ownership = getSessionOwnership(db, input.sessionUri);
  if (!ownership) return { success: false, reason: "not-found" };
  if (ownership.revision !== input.expectedRevision) return { success: false, reason: "stale" };
  if (!ownership.quarantined) return { success: false, reason: "not-quarantined" };
  const hostUrl = resolveSessionOwnershipHost(db, input.sessionUri, input.hostId);
  if (!hostUrl) return { success: false, reason: "unknown-host" };
  if (hasOwnershipRecoveryInFlight(db, input.sessionUri)) return { success: false, reason: "in-flight" };
  const knownHostUrls = ownership.hosts
    .map(({ hostId }) => resolveSessionOwnershipHost(db, input.sessionUri, hostId))
    .filter((host): host is string => host !== undefined);
  const deadline = AbortSignal.timeout(10_000);
  const readSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  try {
    const sdkSummary = await awaitAbortable(() => withAHPClient(hostUrl, async (client) =>
      (await listAllSessions(client)).find(({ resource }) => resource === input.sessionUri), readSignal), readSignal);
    throwIfAborted(readSignal);
    if (!sdkSummary) return { success: false, reason: "catalog-missing" };
    const summary = mapSdkSessionSummary(sdkSummary);
    attachAHPSourceRevision(summary, sdkSummary);
    const result = recoverSessionOwnership(db, { ...input, summary });
    if (result.success) {
      publishOwnershipRecovery(knownHostUrls, {
        session: summary,
        selectedHostUrl: hostUrl,
        revision: result.ownership.revision,
      });
    }
    return result;
  } catch {
    // Transport failures may contain token-bearing host URLs. The diagnostic
    // endpoint deliberately returns a bounded, non-secret failure instead.
    return { success: false, reason: "catalog-unavailable" };
  }
}
