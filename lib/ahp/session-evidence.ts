import "server-only";

import type { AhpClient } from "@microsoft/agent-host-protocol/client";
import type { ChatState } from "@microsoft/agent-host-protocol";

import { awaitAbortable, throwIfAborted } from "../abort";
import { compareAndSwapSessionCache, getSessionCacheSnapshot } from "../db/session-cache";
import type { PendingInput } from "../types";
import { listAllSessions } from "./catalog";
import { enrichChangesetState, findSessionChangeset, type ChangesetEnrichment } from "./changeset-enricher";
import { withAHPClient } from "./client-operation";
import { mapSessionInputNeeded } from "./map-session";
import {
  EvidenceCaptureBudget,
  EvidenceCaptureLimitError,
  EVIDENCE_CAPTURE_LIMITS,
  type EvidenceCaptureFailure,
  type EvidenceCaptureLimits,
} from "./evidence-budget";
import { fetchCopilotCliArtifacts } from "./plan-artifact";
import { projectSessionDetails } from "./session-details-core";
import { extractModelFromConfig } from "./session-config";
import { mapSdkSessionSummary } from "./session-summary";
import { withChangesetState, withChatState, withSessionState, type StateAccess } from "./snapshot";
import {
  attachAHPSourceRevision,
  beginEvidenceRead,
  bindEnrichment,
  cacheableSummary,
  isEvidenceReadCurrent,
  mergeFreshEnrichment,
  publishEvidenceRefresh,
  releaseEvidenceRead,
  sessionSignature,
} from "./source-binding";
import type { AHPSessionSummary } from "./types";

export type SessionEvidenceResult =
  | { success: true; session: AHPSessionSummary; enrichment: ChangesetEnrichment; pendingInput?: PendingInput }
  | { success: false; reason: "unavailable" | "changed" | "superseded" | "unsupported"; detail?: EvidenceCaptureFailure };

class EvidenceChangedError extends Error {}
class EvidenceSupersededError extends Error {}

function sameSource(a: AHPSessionSummary, b: AHPSessionSummary): boolean {
  return a.resource === b.resource && a.provider === b.provider
    && a.modifiedAt === b.modifiedAt && sessionSignature(a) === sessionSignature(b);
}

async function catalogSession(client: AhpClient, sessionUri: string): Promise<AHPSessionSummary | undefined> {
  const sdkSummary = (await listAllSessions(client)).find((item) => item.resource === sessionUri);
  if (!sdkSummary) return undefined;
  const summary = mapSdkSessionSummary(sdkSummary);
  attachAHPSourceRevision(summary, sdkSummary);
  return summary;
}

function artifactContents(enrichment: ChangesetEnrichment): string {
  return JSON.stringify({
    files: enrichment.capturedFilesDigest ?? null,
    artifacts: enrichment.artifacts.map(({ id, type, contentRef }) => ({ id, type, contentRef }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  });
}

/**
 * Deliberate full evidence read. Subscribing may restore/resume the provider.
 * Catalog fences, owned streams and repeated captures detect observed changes;
 * the host protocol does not provide an atomic snapshot or ongoing byte freshness.
 */
export async function refreshSessionEvidence(
  hostUrl: string,
  sessionUri: string,
  signal?: AbortSignal,
  limits: Readonly<EvidenceCaptureLimits> = EVIDENCE_CAPTURE_LIMITS,
): Promise<SessionEvidenceResult> {
  throwIfAborted(signal);
  const cached = getSessionCacheSnapshot(hostUrl, sessionUri);
  if (!cached) return { success: false, reason: "unavailable" };
  const requestSignal = signal;
  const budget = new EvidenceCaptureBudget(limits, signal);
  signal = budget.signal;
  const generation = beginEvidenceRead(hostUrl, sessionUri);
  let committed: Extract<SessionEvidenceResult, { success: true }> | undefined;
  const assertCurrent = () => {
    budget.assertCurrent();
    if (!isEvidenceReadCurrent(hostUrl, sessionUri, generation)) throw new EvidenceSupersededError();
  };
  try {
    // Invalidate synchronously: interruption must not leave older verified facts current.
    if (!compareAndSwapSessionCache(hostUrl, sessionUri, cached.cacheToken,
      cacheableSummary(cached.summary, undefined), null)) {
      return { success: false, reason: "superseded" };
    }
    const invalidated = getSessionCacheSnapshot(hostUrl, sessionUri);
    if (!invalidated) return { success: false, reason: "unavailable" };
    publishEvidenceRefresh(hostUrl, { session: cached.summary, enrichment: null });
    return await awaitAbortable(() => withAHPClient(hostUrl, async (client) => {
      assertCurrent();
      const before = await catalogSession(client, sessionUri);
      assertCurrent();
      if (!before || !sameSource(before, cached.summary)) throw new EvidenceChangedError();

      return withSessionState(client, sessionUri, async (state, session) => {
        if (!state) throw new EvidenceChangedError();
        const sessionAtStart = JSON.stringify(state);
        const assertSession = () => {
          assertCurrent();
          session.assertCurrent();
          if (JSON.stringify(session.getState()) !== sessionAtStart) throw new EvidenceChangedError();
        };
        const capture = async (
          chatState: ChatState | undefined,
          chat?: StateAccess<ChatState>,
        ): Promise<SessionEvidenceResult> => {
          const chatAtStart = JSON.stringify(chatState);
          const assertStreams = () => {
            assertSession();
            chat?.assertCurrent();
            if (chat && JSON.stringify(chat.getState()) !== chatAtStart) throw new EvidenceChangedError();
          };
          const selected = findSessionChangeset(state.changesets ?? []);
          const read = async (
            changesetCapture: () => Promise<ChangesetEnrichment | null>,
            assertChangeset = () => {},
          ) => {
            const collect = async () => {
              assertStreams();
              const [changeset, artifacts] = await Promise.all([
                changesetCapture(),
                // Do not reuse cached misses for an intentional capture.
                fetchCopilotCliArtifacts(client, sessionUri, before.modifiedAt, {}, true, budget),
              ]);
              assertStreams();
              const result = mergeFreshEnrichment(changeset, artifacts, projectSessionDetails(state, chatState));
              if (!result) throw new EvidenceChangedError();
              return result;
            };
            const captured = await collect();
            const verified = await collect();
            if (artifactContents(captured) !== artifactContents(verified)) throw new EvidenceChangedError();
            const after = await catalogSession(client, sessionUri);
            assertStreams();
            assertChangeset();
            if (!after || !sameSource(before, after)) throw new EvidenceChangedError();
            const summary = { ...after, model: after.model ?? extractModelFromConfig(state.config) };
            const pendingInput = mapSessionInputNeeded(session.getState()?.inputNeeded);
            const enrichment = bindEnrichment(summary, verified, "explicit");
            assertCurrent();
            if (!compareAndSwapSessionCache(hostUrl, sessionUri, invalidated.cacheToken,
              cacheableSummary(summary, pendingInput, enrichment), enrichment)) {
              throw new EvidenceSupersededError();
            }
            committed = { success: true, session: summary, enrichment, pendingInput };
            publishEvidenceRefresh(hostUrl, { session: summary, enrichment, pendingInput });
            return committed;
          };
          if (!selected) return read(async () => null);
          if (selected.uriTemplate.includes("{")) throw new EvidenceCaptureLimitError("changeset-template");
          return withChangesetState(client, selected.uriTemplate, async (initial, changeset) => {
            if (initial?.status === "computing" || initial?.status === "recomputing") {
              await changeset.waitFor((value) => value?.status === "ready" || value?.status === "error", 5_000, signal);
            }
            const ready = changeset.getState();
            if (!ready || ready.status !== "ready") throw new EvidenceChangedError();
            budget.assertFileCount(ready.files.length);
            const manifestAtStart = JSON.stringify(ready);
            const assertChangeset = () => {
              changeset.assertCurrent();
              if (JSON.stringify(changeset.getState()) !== manifestAtStart) throw new EvidenceChangedError();
            };
            return read(async () => {
              assertChangeset();
              const result = await enrichChangesetState(client, selected, ready, true, signal, budget);
              assertChangeset();
              return result;
            }, assertChangeset);
          }, signal);
        };
        return state.defaultChat
          ? withChatState(client, state.defaultChat, async (chatState, chat) => {
            if (!chatState) throw new EvidenceChangedError();
            return capture(chatState, chat);
          }, signal)
          : capture(undefined);
      }, signal);
    }, signal), signal);
  } catch (error) {
    // A confirmed CAS must not be reported unavailable just because cleanup ran
    // into the total deadline after persistence and stream publication.
    if (committed) return committed;
    throwIfAborted(requestSignal);
    const limitError = budget.signal.reason instanceof EvidenceCaptureLimitError
      ? budget.signal.reason : error instanceof EvidenceCaptureLimitError ? error : undefined;
    if (limitError) {
      return {
        success: false,
        reason: limitError.detail === "deadline" ? "unavailable" : "unsupported",
        detail: limitError.detail,
      };
    }
    if (error instanceof EvidenceSupersededError) return { success: false, reason: "superseded" };
    if (error instanceof EvidenceChangedError) return { success: false, reason: "changed" };
    throw error;
  } finally {
    budget.dispose();
    releaseEvidenceRead(hostUrl, sessionUri, generation);
  }
}
