import type { AhpClient } from "@microsoft/agent-host-protocol/client";
import {
  sessionReducer,
  type SessionAction,
  type UsageInfo,
  type ChatState,
} from "@microsoft/agent-host-protocol";

import { type AHPSessionSummary, type AHPEvent, AHPStatus, shouldShowSession } from "./types";
import { classifyError, type ConnectionError } from "./connection-error";
import { classifyAhpError } from "./rpc-error";
import { enrichFromChangeset, type ChangesetEnrichment } from "./changeset-enricher";
import { fetchCopilotCliArtifacts } from "./plan-artifact";
import { extractModelFromConfig } from "./session-config";
import { mapSessionInputNeeded } from "./map-session";
import { asChatState, asSessionState, withSessionState } from "./snapshot";
import { upsertSessionCache, removeSessionCache, reconcileSessionCache, getCachedSessions, CLEAR_ENRICHMENT, type CachedSession } from "@/lib/db/session-cache";
import { getDb } from "@/lib/db/schema";
import { claimSessionOwnership, isSessionOwnedByHost } from "@/lib/db/session-ownership";
import { TelemetryTapTransport } from "./telemetry-transport";
import { handleOtlpLogs } from "./telemetry-logs";
import { listAllSessions } from "./catalog";
import { connectInitializedAhpClient, type AhpEndpointDiagnostics } from "./endpoint";
import {
  applySdkSessionSummaryChanges,
  mapSdkSessionSummary,
} from "./session-summary";
import {
  isSessionCompletion,
  shouldEnrichSessionOnChange,
  shouldEnrichSessionOnStartup,
  shouldReadLiveSessionState,
} from "./session-read-policy";
import { withAHPClient } from "./client-operation";
import type { PendingInput, WorkerActivity } from "@/lib/types";
import { observeChatFacts, shouldObserveChat, visibleBackgroundWork } from "./chat-facts";
import { mapWorkerChats, retainInactiveWorkers, type WorkerChatSummary } from "./worker-activity";
import { getWorkerActivityHistory, recordWorkerActivity } from "@/lib/orchestrator/worker-activity-store";
import { readSessionDetailsForState } from "./session-details";
import {
  attachAHPSourceRevision,
  beginEvidenceRead,
  bindEnrichment,
  cacheableSummary,
  enrichmentMatchesSummary,
  isEvidenceReadCurrent,
  invalidateEvidenceReads,
  mergeFreshEnrichment,
  observeEvidenceRefresh,
  observeOwnershipRecovery,
  releaseEvidenceRead,
  riskFactsSourceBinding,
  sessionSignature,
  type SourceAwareSummary,
} from "./source-binding";

export { mergeFreshEnrichment } from "./source-binding";

// Re-export for consumers that imported from here
export type { ConnectionErrorCode, ConnectionError } from "./connection-error";

export type BridgeEvent =
  | { type: "init"; sessions: AHPSessionSummary[]; enrichments: Map<string, ChangesetEnrichment>; pendingInputs: Map<string, PendingInput>; workers: Map<string, WorkerActivity[]>; connection: AhpEndpointDiagnostics & { protocolVersion: string; totalSessions: number; visibleSessions: number; filteredSessions: number } }
  | (AHPEvent & { enrichment?: ChangesetEnrichment | null; pendingInput?: PendingInput | null; workers?: WorkerActivity[] })
  | ConnectionError;

const LOG_PREFIX = "[ahp:bridge]";
const debug = (...args: unknown[]) => {
  if (process.env.AHP_DEBUG) console.debug(LOG_PREFIX, ...args);
};
const info = (...args: unknown[]) => console.info(LOG_PREFIX, ...args);
const warn = (...args: unknown[]) => console.warn(LOG_PREFIX, ...args);
const error = (...args: unknown[]) => console.error(LOG_PREFIX, ...args);

/**
 * Expand RFC 6570 level template variable in a telemetry channel URI.
 * Handles: `{level}` (simple), `{?level}` (query), `{&level}` (continuation).
 * If no template variable is present, returns the URI as-is.
 */
function expandLevelTemplate(uri: string, level: string): string {
  return uri
    .replace("{level}", level)
    .replace("{?level}", `?level=${level}`)
    .replace("{&level}", `&level=${level}`);
}

export interface AHPBridgeOptions {
  hostUrl: string;
  onEvent: (event: BridgeEvent) => void;
  signal?: AbortSignal;
}

/**
 * Connects to a real AHP host and bridges notifications as Planwerk events.
 * Returns a cleanup function. Emits events via the onEvent callback.
 */
export async function createAHPBridge({ hostUrl, onEvent: sendEvent, signal }: AHPBridgeOptions): Promise<() => void> {
  const sessions = new Map<string, AHPSessionSummary>();
  // Archived sessions skipped during init/add — re-evaluated if changes arrive later
  const skippedArchived = new Map<string, AHPSessionSummary>();
  // Changeset enrichment cache per session
  const enrichments = new Map<string, ChangesetEnrichment>();
  // Track in-flight enrichment requests to avoid duplicates
  const pendingEnrichments = new Set<string>();
  // Pending input data per session (fetched on-demand when InputNeeded)
  const pendingInputs = new Map<string, PendingInput>();
  // Track in-flight input fetches to avoid duplicates
  const pendingInputFetches = new Set<string>();
  const workersBySession = new Map<string, WorkerActivity[]>();
  const workerChatsBySession = new Map<string, WorkerChatSummary[]>();
  const workerObservers = new Map<string, { close: () => void }>();
  const workerUsageByChat = new Map<string, NonNullable<WorkerActivity["usage"]>>();
  const liveChatStates = new Map<string, { sessionUri: string; state: ChatState }>();
  const chatObservers = new Map<string, { sessionUri: string; close: () => void }>();
  const readsController = new AbortController();

  let disposed = false;
  let client: AhpClient | null = null;
  const ownsSession = (uri: string) => isSessionOwnedByHost(getDb(), uri, hostUrl);
  function onEvent(event: BridgeEvent) {
    if ((event.type === "sessionAdded" || event.type === "sessionSummaryChanged")
      && !ownsSession(event.session.resource)) {
      sendEvent({ ...event, enrichment: null, pendingInput: null, workers: [] });
      return;
    }
    if (event.type === "init") {
      const allowed = new Set(event.sessions.filter((session) => ownsSession(session.resource)).map((session) => session.resource));
      sendEvent({
        ...event,
        enrichments: new Map([...event.enrichments].filter(([uri]) => allowed.has(uri))),
        pendingInputs: new Map([...event.pendingInputs].filter(([uri]) => allowed.has(uri))),
        workers: new Map([...event.workers].filter(([uri]) => allowed.has(uri))),
        connection: {
          ...event.connection,
          visibleSessions: event.sessions.length,
          filteredSessions: event.connection.totalSessions - event.sessions.length,
        },
      });
      return;
    }
    sendEvent(event);
  }
  const stopEvidenceRefresh = observeEvidenceRefresh(hostUrl, (update) => {
    const current = sessions.get(update.session.resource);
    if (disposed || !current || !ownsSession(update.session.resource)
      || sessionSignature(current) !== sessionSignature(update.session)
      || current.modifiedAt !== update.session.modifiedAt) return;
    const summary = { ...update.session } as AHPSessionSummary & { _planwerkRiskFacts?: unknown };
    // Cached binding belongs to its persisted enrichment, not future live facts.
    delete summary._planwerkRiskFacts;
    sessions.set(update.session.resource, summary);
    if (update.enrichment) enrichments.set(update.session.resource, update.enrichment);
    else enrichments.delete(update.session.resource);
    if (update.pendingInput) pendingInputs.set(update.session.resource, update.pendingInput);
    else if (update.enrichment) pendingInputs.delete(update.session.resource);
    onEvent({
      type: "sessionSummaryChanged",
      session: summary,
      enrichment: update.enrichment,
      pendingInput: pendingInputs.get(update.session.resource) ?? null,
      workers: workersBySession.get(update.session.resource),
    });
  });
  const stopOwnershipRecovery = observeOwnershipRecovery(hostUrl, (update) => {
    if (disposed) return;
    const uri = update.session.resource;
    const current = sessions.get(uri);
    stopWorkerObserver(uri);
    enrichments.delete(uri);
    pendingInputs.delete(uri);
    workersBySession.delete(uri);
    invalidateEvidenceReads(hostUrl, uri);
    if (update.selectedHostUrl === hostUrl) {
      const summary = { ...update.session, lastEvidenceCapture: current?.lastEvidenceCapture };
      sessions.set(uri, summary);
      onEvent({ type: current ? "sessionSummaryChanged" : "sessionAdded", session: summary, enrichment: null, pendingInput: null });
    } else if (current) {
      onEvent({ type: "sessionSummaryChanged", session: current, enrichment: null, pendingInput: null, workers: [] });
    }
  });

  function persistSessionSummary(
    summary: AHPSessionSummary,
    enrichment?: ChangesetEnrichment | null | typeof CLEAR_ENRICHMENT,
  ): void {
    if (!ownsSession(summary.resource)) return;
    upsertSessionCache(
      hostUrl,
      summary.resource,
      cacheableSummary(
        summary,
        pendingInputs.get(summary.resource),
        enrichment && enrichment !== CLEAR_ENRICHMENT ? enrichment : null,
      ),
      enrichment,
    );
  }

  function persistCurrentSessionSummary(summary: AHPSessionSummary): void {
    persistSessionSummary(
      summary,
      enrichments.get(summary.resource) ?? CLEAR_ENRICHMENT,
    );
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    stopEvidenceRefresh();
    stopOwnershipRecovery();
    for (const uri of sessions.keys()) invalidateEvidenceReads(hostUrl, uri);
    readsController.abort();
    pendingInputs.clear();
    workersBySession.clear();
    workerChatsBySession.clear();
    for (const observer of workerObservers.values()) observer.close();
    workerObservers.clear();
    for (const observer of chatObservers.values()) observer.close();
    chatObservers.clear();
    workerUsageByChat.clear();
    liveChatStates.clear();
    client?.shutdown().catch(() => {});
  }

  /**
   * Trigger async changeset enrichment for a session. On completion,
   * re-emits the card with enrichment data applied.
   *
   * Also fetches plan.md from Copilot CLI session-state as a fallback
   * artifact source (plan.md lives outside the git working tree).
   */
  // Track sessions that changed while enrichment was in-flight
  const dirtyEnrichments = new Set<string>();
  const completionReads = new Map<string, number>();
  const enrichmentVersions = new Map<string, number>();

  function triggerEnrichment(sessionUri: string) {
    if (disposed || !client) return;

    const session = sessions.get(sessionUri);
    if (!session) return;
    const eligible = () => {
      const current = sessions.get(sessionUri);
      return !disposed && current !== undefined && ownsSession(sessionUri)
        && (current.status & AHPStatus.IsArchived) === 0
        && (shouldReadLiveSessionState(current.status)
          || completionReads.get(sessionUri) === current.status);
    };
    if (!eligible()) return;

    // If already in-flight, mark dirty for re-enrichment after completion
    if (pendingEnrichments.has(sessionUri)) {
      dirtyEnrichments.add(sessionUri);
      return;
    }

    pendingEnrichments.add(sessionUri);
    const readGeneration = beginEvidenceRead(hostUrl, sessionUri);
    let sourceAtStart = riskFactsSourceBinding(session);
    let versionAtStart = enrichmentVersions.get(sessionUri);

    // A refresh is an unknown state until it completes. Clear both in-memory and
    // persisted facts before any asynchronous read so a failed or pending refresh
    // can never retain a previously verified changeset or plan.
    enrichments.delete(sessionUri);
    persistSessionSummary(session, CLEAR_ENRICHMENT);
    onEvent({
      type: "sessionSummaryChanged",
      session,
      enrichment: null,
      pendingInput: pendingInputs.get(sessionUri),
      workers: workersBySession.get(sessionUri),
    });

    // Read SessionState once. A session subscribe may restore/provider-resume
    // the session, and parallel model + changeset reads previously subscribed
    // to the same channel twice.
    withAHPClient(hostUrl, async (detailClient) => {
      // Connection acquisition is asynchronous. Recheck queued work immediately
      // before subscribing, and consume completion permission exactly once.
      if (!eligible()) return undefined;
      completionReads.delete(sessionUri);
      sourceAtStart = riskFactsSourceBinding(session);
      versionAtStart = enrichmentVersions.get(sessionUri);
      return withSessionState(detailClient, sessionUri, async (state) => {
        if (!state) throw new Error("The agent host did not return session state");
        return Promise.all([
          (session.changes?.files ?? 0) > 0 ? enrichFromChangeset(detailClient, sessionUri, state) : null,
          fetchCopilotCliArtifacts(detailClient, sessionUri, session.modifiedAt, readsController),
          session.model ?? extractModelFromConfig(state.config),
          readSessionDetailsForState(detailClient, state),
        ]);
      });
    }, readsController.signal)
      .then((result) => {
        if (!result) return;
        const [changesetResult, sessionArtifacts, model, sessionDetails] = result;
        if (disposed || !sessions.has(sessionUri) || !ownsSession(sessionUri)
          || !isEvidenceReadCurrent(hostUrl, sessionUri, readGeneration)) return;

        if (model) {
          const current = sessions.get(sessionUri);
          if (current && !current.model) current.model = model;
        }
        const current = sessions.get(sessionUri);
        if (!current || (current.status & AHPStatus.IsArchived) !== 0) return;
        const currentSource = riskFactsSourceBinding(current);
        if (
          currentSource.sourceRevision !== sourceAtStart.sourceRevision
          || currentSource.planVersion !== sourceAtStart.planVersion
          || enrichmentVersions.get(sessionUri) !== versionAtStart
        ) {
          // Only a meaningful event may queue another read. In particular, a
          // subscribe-induced timestamp must not sustain a read/write loop.
          return;
        }

        const fresh = mergeFreshEnrichment(
          changesetResult,
          sessionArtifacts,
          sessionDetails,
        );
        const enrichment = fresh ? bindEnrichment(current, fresh) : null;
        if (enrichment) {
          enrichments.set(sessionUri, enrichment);
          persistSessionSummary(current, enrichment);
        } else {
          persistSessionSummary(current, CLEAR_ENRICHMENT);
        }
        onEvent({
          type: "sessionSummaryChanged",
          session: current,
          enrichment,
          pendingInput: pendingInputs.get(sessionUri),
          workers: workersBySession.get(sessionUri),
        });
      })
      .catch((err) => {
        if (disposed || !ownsSession(sessionUri)
          || !isEvidenceReadCurrent(hostUrl, sessionUri, readGeneration)) return;
        const current = sessions.get(sessionUri);
        if (current) persistSessionSummary(current, CLEAR_ENRICHMENT);
        warn(
          "enrichment refresh failed:",
          sessionUri,
          err instanceof Error ? err.message : err,
        );
      })
      .finally(() => {
        releaseEvidenceRead(hostUrl, sessionUri, readGeneration);
        pendingEnrichments.delete(sessionUri);
        // Re-enrich if session changed while we were processing
        if (dirtyEnrichments.has(sessionUri)) {
          dirtyEnrichments.delete(sessionUri);
          triggerEnrichment(sessionUri);
        }
      });
  }

  /**
   * One-shot fetch of session-level inputNeeded for a session in InputNeeded state.
   * Subscribes to get the snapshot, extracts input data, then immediately unsubscribes.
   * Uses a dirty flag to refetch if the session changes while a fetch is in-flight.
   */
  const dirtyInputFetches = new Set<string>();

  function fetchInputOnce(sessionUri: string) {
    if (disposed || !client || !stillInputNeeded(sessionUri)) return;

    // If already in-flight, mark dirty for re-fetch after completion
    if (pendingInputFetches.has(sessionUri)) {
      dirtyInputFetches.add(sessionUri);
      return;
    }

    pendingInputFetches.add(sessionUri);
    debug("fetchInput: reading session inputNeeded", sessionUri);

    fetchInputFromSession(sessionUri)
      .catch((err) => {
        warn("fetchInput: failed", sessionUri, err instanceof Error ? err.message : err);
      })
      .finally(() => {
        pendingInputFetches.delete(sessionUri);
        // Re-fetch if session changed while we were in-flight
        if (dirtyInputFetches.has(sessionUri)) {
          dirtyInputFetches.delete(sessionUri);
          const currentSession = sessions.get(sessionUri);
          if (currentSession && (currentSession.status & AHPStatus.InputNeeded) === AHPStatus.InputNeeded) {
            fetchInputOnce(sessionUri);
          }
        }
      });
  }

  const stillInputNeeded = (sessionUri: string): boolean => {
    if (!ownsSession(sessionUri)) return false;
    const s = sessions.get(sessionUri);
    return s !== undefined && shouldReadLiveSessionState(s.status)
      && (s.status & AHPStatus.InputNeeded) === AHPStatus.InputNeeded;
  };

  /**
   * Read a session's aggregated `SessionState.inputNeeded` (the session-level
   * input surface) and emit the most actionable pending input — an elicitation, a tool
   * confirmation, or a read-only client-execution blocker — across every chat.
   *
   * If the session reports InputNeeded but the snapshot's `inputNeeded` hasn't populated
   * yet (a race between the status flag and `session/inputNeededSet`), briefly wait for
   * that action, then re-read.
   */
  async function fetchInputFromSession(sessionUri: string) {
    if (disposed || !client) return;

    try {
      await withAHPClient(hostUrl, async (detailClient) => {
        if (disposed || !stillInputNeeded(sessionUri)) return;
        let sub: Awaited<ReturnType<typeof detailClient.subscribe>>;
        try {
          sub = await detailClient.subscribe(sessionUri);
        } catch (err) {
          warn("fetchInput: session subscribe failed", sessionUri, err instanceof Error ? err.message : err);
          emitNoPendingInput(sessionUri);
          return;
        }

        const { result, subscription } = sub;
        try {
          if (disposed) return;

          // Re-check: status may have changed while the subscribe was in-flight.
          if (!stillInputNeeded(sessionUri)) {
            debug("fetchInput: no longer needed (status changed)", sessionUri);
            return;
          }

          let sessionState = asSessionState(result.snapshot);
          const initial = mapSessionInputNeeded(sessionState?.inputNeeded);
          if (initial) {
            emitPendingInput(sessionUri, initial);
            return;
          }
          if (!sessionState) {
            emitNoPendingInput(sessionUri);
            return;
          }

          // inputNeeded not populated yet — wait briefly for session/inputNeededSet.
          debug("fetchInput: no inputNeeded yet, waiting…", sessionUri);
          const timer = setTimeout(() => void subscription.close(), 5_000);
          try {
            for await (const event of subscription) {
              if (disposed) break;
              if (event.type !== "action") continue;
              sessionState = sessionReducer(
                sessionState,
                event.params.action as SessionAction,
              );
              const mapped = mapSessionInputNeeded(sessionState.inputNeeded);
              if (mapped) {
                emitPendingInput(sessionUri, mapped);
                return;
              }
            }
          } finally {
            clearTimeout(timer);
          }

          emitNoPendingInput(sessionUri);
        } finally {
          await subscription.close();
          await detailClient.unsubscribe(sessionUri).catch(() => {});
        }
      }, readsController.signal);
    } catch (err) {
      warn("fetchInput: failed", sessionUri, err instanceof Error ? err.message : err);
      emitNoPendingInput(sessionUri);
    }
  }

  function emitPendingInput(sessionUri: string, mapped: PendingInput) {
    pendingInputs.set(sessionUri, mapped);
    debug("pending input:", sessionUri, mapped.requestId);
    const session = sessions.get(sessionUri)!;
    if (session) {
      persistCurrentSessionSummary(session);
      onEvent({
        type: "sessionSummaryChanged",
        session,
        enrichment: enrichments.get(sessionUri) ?? null,
        pendingInput: mapped,
      });
    }
  }

  function emitNoPendingInput(sessionUri: string) {
    if (!pendingInputs.has(sessionUri)) return;
    debug("clearing pending input:", sessionUri);
    pendingInputs.delete(sessionUri);
    const session = sessions.get(sessionUri);
    if (session) {
      persistCurrentSessionSummary(session);
      onEvent({
        type: "sessionSummaryChanged",
        session,
        enrichment: enrichments.get(sessionUri) ?? null,
        pendingInput: null,
      });
    }
  }

  /** Clear pending input when session is no longer input-needed. Emits null to downstream. */
  function clearPendingInput(sessionUri: string) {
    dirtyInputFetches.delete(sessionUri);
    if (!pendingInputs.has(sessionUri)) return;
    debug("clearing pending input:", sessionUri);
    pendingInputs.delete(sessionUri);
    const session = sessions.get(sessionUri);
    if (session) {
      persistCurrentSessionSummary(session);
      onEvent({
        type: "sessionSummaryChanged",
        session,
        enrichment: enrichments.get(sessionUri) ?? null,
        pendingInput: null,
      });
    }
  }

  /** Check session status and fetch input data or clear it. */
  function syncInputState(sessionUri: string, status: number) {
    const needsInput = (status & AHPStatus.InputNeeded) === AHPStatus.InputNeeded;
    const isArchived = (status & AHPStatus.IsArchived) !== 0;
    if (needsInput && !isArchived) {
      fetchInputOnce(sessionUri);
    } else {
      clearPendingInput(sessionUri);
    }
  }

  function emitWorkers(sessionUri: string, workers: WorkerActivity[]) {
    workersBySession.set(sessionUri, workers);
    const session = sessions.get(sessionUri);
    if (session) {
      onEvent({
        type: "sessionSummaryChanged",
        session,
        enrichment: enrichments.get(sessionUri) ?? null,
        pendingInput: pendingInputs.get(sessionUri),
        workers,
      });
    }
  }

  function toWorkerUsage(usage: UsageInfo | undefined): NonNullable<WorkerActivity["usage"]> | undefined {
    if (
      !usage
      || (
        usage.inputTokens === undefined
        && usage.outputTokens === undefined
        && usage.cacheReadTokens === undefined
      )
    ) {
      return undefined;
    }
    return {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens,
    };
  }

  function sumWorkerUsage(
    usages: readonly (WorkerActivity["usage"])[],
  ): NonNullable<WorkerActivity["usage"]> | undefined {
    const present = usages.filter(
      (usage): usage is NonNullable<WorkerActivity["usage"]> => usage !== undefined,
    );
    if (present.length === 0) return undefined;

    const sumField = (
      field: keyof NonNullable<WorkerActivity["usage"]>,
    ): number | undefined => {
      const values = present
        .map((usage) => usage[field])
        .filter((value): value is number => value !== undefined);
      return values.length > 0
        ? values.reduce((total, value) => total + value, 0)
        : undefined;
    };

    return {
      inputTokens: sumField("inputTokens"),
      outputTokens: sumField("outputTokens"),
      cacheReadTokens: sumField("cacheReadTokens"),
    };
  }

  function completedUsageFromChat(
    chat: ReturnType<typeof asChatState>,
  ): NonNullable<WorkerActivity["usage"]> | undefined {
    return sumWorkerUsage(chat?.turns.map((turn) => toWorkerUsage(turn.usage)) ?? []);
  }

  function usageFromChat(chat: ReturnType<typeof asChatState>): NonNullable<WorkerActivity["usage"]> | undefined {
    return sumWorkerUsage([
      completedUsageFromChat(chat),
      toWorkerUsage(chat?.activeTurn?.usage),
    ]);
  }

  function publishChatFacts(sessionUri: string) {
    const session = sessions.get(sessionUri);
    if (!session || disposed) return;
    session.backgroundWork = [...liveChatStates.values()]
      .filter((entry) => entry.sessionUri === sessionUri)
      .flatMap(({ state }) => visibleBackgroundWork(state, session.chats).map((work) => ({ chat: state.resource, work })));
    const previous = workersBySession.get(sessionUri) ?? [];
    const workers = mapWorkerChats(workerChatsBySession.get(sessionUri) ?? session.chats ?? []).map((worker) => ({
      ...worker,
      usage: workerUsageByChat.get(worker.id),
      history: previous.find((item) => item.id === worker.id)?.history ?? [],
    }));
    const hidden = new Set(session.chats?.filter((chat) => chat.interactivity === "hidden").map((chat) => chat.resource));
    emitWorkers(sessionUri, retainInactiveWorkers(previous.filter((worker) => !hidden.has(worker.id)), workers));
  }

  function stopChatObserver(workerId: string) {
    const observer = chatObservers.get(workerId);
    if (!observer) return;
    chatObservers.delete(workerId);
    liveChatStates.delete(workerId);
    observer.close();
  }

  async function observeChat(sessionUri: string, workerId: string): Promise<WorkerActivity["usage"]> {
    if (!client || disposed || !ownsSession(sessionUri)) return undefined;
    const existing = chatObservers.get(workerId);
    if (existing?.sessionUri === sessionUri) return workerUsageByChat.get(workerId);
    const session = sessions.get(sessionUri);
    if (!session || !shouldReadLiveSessionState(session.status)) return undefined;
    if (existing) stopChatObserver(workerId);
    const observer = observeChatFacts(client, workerId, (state, details) => {
      if (disposed || !ownsSession(sessionUri) || chatObservers.get(workerId)?.close !== observer.close) return;
      const session = sessions.get(sessionUri);
      if (!session) return;
      liveChatStates.set(workerId, { sessionUri, state });
      const usage = usageFromChat(state);
      if (usage) workerUsageByChat.set(workerId, usage);
      session.chatDetails = { ...session.chatDetails, [workerId]: details };
      const chats = workerChatsBySession.get(sessionUri) ?? [];
      const next = chats.map((chat) => chat.resource === workerId ? {
        ...chat, status: state.status, activity: state.activity,
        interactivity: chat.interactivity ?? state.interactivity,
        changes: chat.changes ?? state.changes,
      } : chat);
      workerChatsBySession.set(sessionUri, next);
      session.chats = next;
      publishChatFacts(sessionUri);
    }, (error) => debug("chat observer failed:", workerId, error instanceof Error ? error.message : error), () => {
      if (chatObservers.get(workerId)?.close !== observer.close) return;
      chatObservers.delete(workerId);
      liveChatStates.delete(workerId);
      const session = sessions.get(sessionUri);
      if (session?.chatDetails) delete session.chatDetails[workerId];
      publishChatFacts(sessionUri);
    });
    chatObservers.set(workerId, { sessionUri, close: observer.close });
    await observer.ready;
    return workerUsageByChat.get(workerId);
  }

  async function applyWorkerChats(sessionUri: string, chats: readonly WorkerChatSummary[]) {
    const workers = mapWorkerChats(chats);
    const visibleIds = new Set(chats.filter((chat) => chat.interactivity !== "hidden" && (chat.status === undefined || (chat.status & AHPStatus.IsArchived) === 0)).map((chat) => chat.resource));
    for (const [chatId, observer] of chatObservers) {
      if (observer.sessionUri === sessionUri && !visibleIds.has(chatId)) {
        stopChatObserver(chatId);
        const session = sessions.get(sessionUri);
        if (session?.chatDetails) delete session.chatDetails[chatId];
      }
    }
    // Cold catalogue entries stay passive. Already-observed chats remain live
    // through idle/input-needed transitions so background work can finish.
    const session = sessions.get(sessionUri);
    await Promise.all(chats.filter((chat) => session && shouldObserveChat(
      chat, session.status, session.defaultChat, chatObservers.has(chat.resource),
    )).map((chat) => observeChat(sessionUri, chat.resource)));
    if (disposed || !sessions.has(sessionUri) || !ownsSession(sessionUri)) return;
    for (const worker of workers) worker.usage = workerUsageByChat.get(worker.id);
    for (const worker of workers) {
      recordWorkerActivity(sessionUri, worker.id, worker.activity);
      worker.history = getWorkerActivityHistory(sessionUri, worker.id);
    }
    const hidden = new Set(chats.filter((chat) => chat.interactivity === "hidden").map((chat) => chat.resource));
    emitWorkers(sessionUri, retainInactiveWorkers((workersBySession.get(sessionUri) ?? []).filter((worker) => !hidden.has(worker.id)), workers));
    publishChatFacts(sessionUri);
  }

  function stopWorkerObserver(sessionUri: string) {
    for (const [workerId, observer] of chatObservers) {
      if (observer.sessionUri === sessionUri) stopChatObserver(workerId);
    }
    const session = sessions.get(sessionUri);
    if (session) { session.backgroundWork = []; session.chatDetails = {}; }
    const observer = workerObservers.get(sessionUri);
    if (!observer) return;
    workerObservers.delete(sessionUri);
    observer.close();
    void client?.unsubscribe(sessionUri).catch(() => {});
  }

  async function syncWorkerActivity(sessionUri: string, status: number) {
    if (
      disposed
      || !client
      || !ownsSession(sessionUri)
      || (status & AHPStatus.IsArchived) !== 0
    ) {
      stopWorkerObserver(sessionUri);
      return;
    }
    const session = sessions.get(sessionUri);
    if (session?.chats !== undefined) {
      const live = workerChatsBySession.get(sessionUri) ?? [];
      workerChatsBySession.set(sessionUri, session.chats.map((chat) => ({ ...live.find((item) => item.resource === chat.resource), ...chat })));
      await applyWorkerChats(sessionUri, workerChatsBySession.get(sessionUri)!);
    }
    const current = sessions.get(sessionUri);
    if (disposed || !current || !ownsSession(sessionUri) || (current.status & AHPStatus.IsArchived) !== 0) {
      stopWorkerObserver(sessionUri);
      return;
    }
    // AHP 1.0 publishes an authoritative ordered catalogue on the root channel.
    // When routing is also known, no parent-session subscription is needed.
    if (
      workerObservers.has(sessionUri)
      || !shouldReadLiveSessionState(current.status)
      || (current.chats !== undefined && current.defaultChat !== undefined)
    ) return;

    const pendingObserver = { close: () => {} };
    workerObservers.set(sessionUri, pendingObserver);
    try {
      const { result, subscription } = await client.subscribe(sessionUri);
      if (disposed || !ownsSession(sessionUri) || workerObservers.get(sessionUri) !== pendingObserver) {
        subscription.close();
        void client.unsubscribe(sessionUri).catch(() => {});
        return;
      }
      const initial = asSessionState(result.snapshot);
      if (!initial) {
        workerObservers.delete(sessionUri);
        subscription.close();
        void client.unsubscribe(sessionUri).catch(() => {});
        return;
      }

      workerObservers.set(sessionUri, subscription);
      const currentSession = sessions.get(sessionUri);
      if (currentSession) {
        currentSession.defaultChat = initial.defaultChat;
        currentSession.chats = initial.chats;
      }
      workerChatsBySession.set(sessionUri, [...initial.chats]);
      await applyWorkerChats(sessionUri, initial.chats);

      let sessionState = initial;
      void (async () => {
        try {
          for await (const event of subscription) {
            if (disposed || !ownsSession(sessionUri) || workerObservers.get(sessionUri) !== subscription) break;
            if (event.type !== "action") continue;
            sessionState = sessionReducer(sessionState, event.params.action as SessionAction);
            if (["session/chatAdded", "session/chatUpdated", "session/chatRemoved", "session/chatsReordered", "session/defaultChatChanged"].includes(event.params.action.type)) {
              const session = sessions.get(sessionUri);
              if (!session) break;
              session.chats = sessionState.chats;
              session.defaultChat = sessionState.defaultChat;
              workerChatsBySession.set(sessionUri, sessionState.chats);
              await applyWorkerChats(sessionUri, sessionState.chats);
            }
          }
        } catch (err) {
          if (!disposed) {
            debug("worker observer failed:", sessionUri, err instanceof Error ? err.message : err);
          }
        } finally {
          if (workerObservers.get(sessionUri) === subscription) {
            workerObservers.delete(sessionUri);
            void client?.unsubscribe(sessionUri).catch(() => {});
          }
        }
      })();
    } catch (err) {
      if (workerObservers.get(sessionUri) === pendingObserver) workerObservers.delete(sessionUri);
      debug("worker activity read failed:", sessionUri, err instanceof Error ? err.message : err);
    }
  }

  if (signal) {
    if (signal.aborted) {
      dispose();
      return dispose;
    }
    signal.addEventListener("abort", dispose, { once: true });
  }

  let connection: Awaited<ReturnType<typeof connectInitializedAhpClient>>;
  try {
    connection = await connectInitializedAhpClient(hostUrl, {
      initialSubscriptions: ["ahp-root://"],
      wrapTransport: (transport) => new TelemetryTapTransport(transport, (notification) => {
        handleOtlpLogs(notification);
      }),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to connect to AHP host";
    error("connect failed:", message);
    onEvent(classifyAhpError(err, "connect"));
    return dispose;
  }

  if (disposed) {
    await connection.client.shutdown().catch(() => {});
    return dispose;
  }

  client = connection.client;
  const initResult = connection.initialized;

  if (disposed) return dispose;

  info("connected to", hostUrl);

  // Attach the local subscription for the root channel *before* the
  // `listSessions()` round-trip below. The server already subscribed us via
  // `initialSubscriptions`, but the client only starts buffering events for a
  // channel once a local queue exists (`attachSubscription` creates it
  // on-demand; `fanOut` silently drops events for channels with no queue —
  // see dist/client/client.js). Attaching late left a window, spanning the
  // `listSessions()` await, where a root-channel event (e.g. a session
  // finishing a turn) would be dropped.
  const rootSub = client.attachSubscription("ahp-root://");

  // Subscribe to OTLP telemetry logs if the host advertises them
  if (initResult.telemetry?.logs) {
    const logsChannel = expandLevelTemplate(initResult.telemetry.logs, "debug");
    info("subscribing to telemetry logs:", logsChannel);
    client.subscribe(logsChannel).catch((err) => {
      warn("telemetry logs subscription failed; host diagnostics unavailable:", err instanceof Error ? err.message : err);
    });
  } else {
    warn("Host does not advertise telemetry logs; host diagnostics unavailable");
  }

  // Fetch initial session list
  try {
    // Load the persisted cache so unchanged sessions can be hydrated from it
    // rather than re-read from the host. Reading a session over AHP *subscribes*
    // to it, which makes Copilot CLI lazily resume the session and bump its
    // modifiedAt — surfaced in VS Code as a reset "last modified" time. Reusing
    // an immutable host revision lets us avoid unnecessary resumes. Without one,
    // modifiedAt participates in the fallback revision so cache reuse fails closed.
    const cacheByUri = new Map<string, CachedSession>();
    try {
      for (const cached of getCachedSessions(hostUrl)) {
        cacheByUri.set(cached.sessionUri, cached);
      }
    } catch { /* cache read failure is non-fatal */ }

    // Live detail reads subscribe to session channels. On VS Code's Agent Host,
    // that is a restore/resume operation rather than a passive snapshot read.
    // Keep cold startup catalog-only and inspect only sessions already active.
    const liveReadUris = new Set<string>();
    const staleEnrichmentUris = new Set<string>();
    let coldSummaryOnlyCount = 0;

    const allSummaries = await listAllSessions(client);

    for (const summary of allSummaries) {
      const owned = claimSessionOwnership(getDb(), summary.resource, hostUrl);
      const mapped = mapSdkSessionSummary(summary);
      attachAHPSourceRevision(mapped, summary);
      if (!shouldShowSession(summary.status, summary.changes?.files ?? 0)) {
        if (summary.status & AHPStatus.IsArchived) skippedArchived.set(summary.resource, mapped);
        continue;
      }

      const cached = cacheByUri.get(mapped.resource);
      mapped.lastEvidenceCapture = cached?.summary.lastEvidenceCapture ?? cached?.enrichment?.evidenceCapture;
      if (!owned) {
        sessions.set(mapped.resource, mapped);
        continue;
      }
      const unchangedSummary =
        cached && sessionSignature(cached.summary) === sessionSignature(mapped);
      const planVersionChanged = Boolean(
        cached
        && cached.summary.modifiedAt !== mapped.modifiedAt,
      );
      const unchanged = Boolean(unchangedSummary && !planVersionChanged);
      let hasCurrentCachedEnrichment = false;

      if (unchanged && cached) {
        // Preserve the host's catalog timestamp, not an invented activity time.
        // Aggregate counts alone are never enough to reuse enrichment.
        if (cached.summary.model && !mapped.model) mapped.model = cached.summary.model;
        if (
          cached.enrichment
          && enrichmentMatchesSummary(mapped, cached.enrichment)
        ) {
          enrichments.set(mapped.resource, cached.enrichment);
          hasCurrentCachedEnrichment = true;
        } else if (cached.enrichment) {
          staleEnrichmentUris.add(mapped.resource);
        }
      } else {
        // Never project stale file/plan facts onto a changed summary. Active
        // sessions can refresh them now; cold sessions remain summary-only until
        // observed activity or an explicit Planwerk action permits a live read.
        if (cached?.enrichment) staleEnrichmentUris.add(mapped.resource);
        if (!shouldReadLiveSessionState(mapped.status)) {
          coldSummaryOnlyCount++;
        }
      }
      if (
        shouldEnrichSessionOnStartup(
          mapped.status,
          unchanged,
          hasCurrentCachedEnrichment,
        )
      ) {
        liveReadUris.add(mapped.resource);
      }

      sessions.set(summary.resource, mapped);
    }
    info(
      `loaded ${sessions.size} sessions (${allSummaries.length} total, archived without changes filtered); `
      + `${liveReadUris.size} active live reads, ${coldSummaryOnlyCount} cold summary-only`,
    );
    onEvent({
      type: "init",
      sessions: Array.from(sessions.values()),
      enrichments,
      pendingInputs,
      workers: workersBySession,
      connection: {
        ...connection.diagnostics,
        protocolVersion: initResult.protocolVersion,
        totalSessions: allSummaries.length,
        visibleSessions: sessions.size,
        filteredSessions: allSummaries.length - sessions.size,
      },
    });

    // Cache all sessions and remove stale entries
    for (const [uri, session] of sessions) {
      const enrichment = enrichments.get(uri) ?? null;
      const cached = cacheByUri.get(uri);
      if (cached
        && JSON.stringify(cached.summary) === JSON.stringify(cacheableSummary(session, pendingInputs.get(uri), enrichment))
        && JSON.stringify(cached.enrichment) === JSON.stringify(enrichment)) {
        continue;
      }
      persistSessionSummary(
        session,
        staleEnrichmentUris.has(uri)
          ? CLEAR_ENRICHMENT
          : enrichments.get(uri) ?? CLEAR_ENRICHMENT,
      );
    }
    const retainedUris = new Set(sessions.keys());
    for (const cached of cacheByUri.values()) {
      if (!ownsSession(cached.sessionUri)) retainedUris.add(cached.sessionUri);
    }
    reconcileSessionCache(hostUrl, retainedUris);

    // Active sessions are already resident/running, so reading their details
    // cannot turn a cold catalog entry into resumed work. InputNeeded is a
    // composite InProgress status and is therefore included in liveReadUris.
    for (const [uri, session] of sessions) {
      if (liveReadUris.has(uri)) triggerEnrichment(uri);
      syncInputState(uri, session.status);
      void syncWorkerActivity(uri, session.status);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to list sessions";
    error("listSessions failed:", message);
    onEvent(classifyAhpError(err, "request"));
    dispose();
    return dispose;
  }

  // Process events in background
  (async () => {
    try {
      for await (const event of rootSub) {
        if (disposed) break;
        const eventSessionUri = event.type === "sessionAdded" ? event.params.summary.resource
          : event.type === "sessionSummaryChanged" || event.type === "sessionRemoved"
            ? event.params.session : undefined;
        if (eventSessionUri && !(event.type === "sessionRemoved"
          ? ownsSession(eventSessionUri)
          : claimSessionOwnership(getDb(), eventSessionUri, hostUrl))) {
          stopWorkerObserver(eventSessionUri);
          const current = sessions.get(eventSessionUri);
          skippedArchived.delete(eventSessionUri);
          enrichments.delete(eventSessionUri);
          pendingInputs.delete(eventSessionUri);
          workersBySession.delete(eventSessionUri);
          invalidateEvidenceReads(hostUrl, eventSessionUri);
          if (event.type === "sessionRemoved") {
            sessions.delete(eventSessionUri);
            onEvent({ type: "sessionRemoved", resource: eventSessionUri, reason: "removed" });
          } else {
            const passive = event.type === "sessionAdded" ? mapSdkSessionSummary(event.params.summary) : current;
            if (passive && event.type === "sessionSummaryChanged") applySdkSessionSummaryChanges(passive, event.params.changes);
            if (passive) {
              sessions.set(eventSessionUri, passive);
              onEvent({ type: current ? "sessionSummaryChanged" : "sessionAdded", session: passive, enrichment: null });
            }
          }
          continue;
        }

        if (event.type === "sessionAdded") {
          const mapped = mapSdkSessionSummary(event.params.summary);
          attachAHPSourceRevision(mapped, event.params.summary);
          if (!shouldShowSession(mapped.status, mapped.changes?.files)) {
            debug("sessionAdded: skipping archived without changes", mapped.resource);
            if (mapped.status & AHPStatus.IsArchived) skippedArchived.set(mapped.resource, mapped);
            continue;
          }
          sessions.set(event.params.summary.resource, mapped);
          persistCurrentSessionSummary(mapped);
          debug("sessionAdded:", mapped.resource, mapped.title);
          onEvent({ type: "sessionAdded", session: mapped, enrichment: enrichments.get(mapped.resource) });
          if (shouldReadLiveSessionState(mapped.status)) {
            triggerEnrichment(mapped.resource);
          }
          syncInputState(mapped.resource, mapped.status);
          void syncWorkerActivity(mapped.resource, mapped.status);
        } else if (event.type === "sessionRemoved") {
          debug("sessionRemoved:", event.params.session);
          stopWorkerObserver(event.params.session);
          const existing = sessions.get(event.params.session);
          sessions.delete(event.params.session);
          invalidateEvidenceReads(hostUrl, event.params.session);
          completionReads.delete(event.params.session);
          dirtyEnrichments.delete(event.params.session);
          enrichmentVersions.set(event.params.session, (enrichmentVersions.get(event.params.session) ?? 0) + 1);
          removeSessionCache(hostUrl, event.params.session);
          clearPendingInput(event.params.session);
          onEvent({
            type: "sessionRemoved",
            resource: event.params.session,
            session: existing,
            reason: "removed",
          });
        } else if (event.type === "sessionSummaryChanged") {
          const { session: sessionUri, changes } = event.params;
          const existing = sessions.get(sessionUri);
          if (existing) {
            debug("sessionChanged:", sessionUri, Object.keys(changes).join(","));
            const sourceBefore = riskFactsSourceBinding(existing);
            const previousStatus = existing.status;
            const previousActivity = existing.activity;
            const previousAHPRevision = (existing as SourceAwareSummary)._planwerkAHPSourceRevision;
            const previousChanges = JSON.stringify(existing.changes);
            applySdkSessionSummaryChanges(existing, changes);
            if (changes._meta !== undefined) {
              attachAHPSourceRevision(existing, changes);
            }
            const sourceAfter = riskFactsSourceBinding(existing);
            const contentChanged =
              previousAHPRevision !== (existing as SourceAwareSummary)._planwerkAHPSourceRevision
              || previousChanges !== JSON.stringify(existing.changes);
            const completed = isSessionCompletion(previousStatus, existing.status);
            const runtimeMask = AHPStatus.Idle | AHPStatus.Error | AHPStatus.InputNeeded;
            const runtimeChanged = (previousStatus & runtimeMask) !== (existing.status & runtimeMask);
            const inputMayHaveChanged = previousStatus !== existing.status
              || previousActivity !== existing.activity
              || contentChanged;
            if (completed) completionReads.set(sessionUri, existing.status);
            else if (existing.status !== previousStatus) completionReads.delete(sessionUri);
            const changesetSourceChanged =
              sourceBefore.sourceRevision !== sourceAfter.sourceRevision;
            const planVersionChanged =
              sourceBefore.planVersion !== sourceAfter.planVersion;
            if (changesetSourceChanged || planVersionChanged || contentChanged || runtimeChanged) {
              invalidateEvidenceReads(hostUrl, sessionUri);
              enrichmentVersions.set(sessionUri, (enrichmentVersions.get(sessionUri) ?? 0) + 1);
              enrichments.delete(sessionUri);
              persistSessionSummary(existing, CLEAR_ENRICHMENT);
            }

            // Check if session became archived
            if (existing.status & AHPStatus.IsArchived) {
              enrichmentVersions.set(sessionUri, (enrichmentVersions.get(sessionUri) ?? 0) + 1);
              completionReads.delete(sessionUri);
              dirtyEnrichments.delete(sessionUri);
              enrichments.delete(sessionUri);
              stopWorkerObserver(sessionUri);
              clearPendingInput(sessionUri);
              if (shouldShowSession(existing.status, existing.changes?.files)) {
                debug("sessionArchived: keeping (has code changes)", sessionUri);
                sessions.set(sessionUri, existing);
                persistCurrentSessionSummary(existing);
                onEvent({ type: "sessionSummaryChanged", session: existing, enrichment: enrichments.get(sessionUri) });
              } else {
                debug("sessionArchived: removing (no code changes)", sessionUri);
                sessions.delete(sessionUri);
                enrichments.delete(sessionUri);
                removeSessionCache(hostUrl, sessionUri);
                onEvent({
                  type: "sessionRemoved",
                  resource: sessionUri,
                  session: existing,
                  reason: "archived",
                });
              }
              continue;
            }

            // Sync input state when status changes
            if (previousStatus !== existing.status) {
              syncInputState(sessionUri, existing.status);
            } else if (
              (existing.status & AHPStatus.InputNeeded) === AHPStatus.InputNeeded
              && inputMayHaveChanged
            ) {
              // Refetch input if session is still InputNeeded but summary changed
              // (host may have replaced the input request without toggling status)
              fetchInputOnce(sessionUri);
            }
            void syncWorkerActivity(sessionUri, existing.status);

            sessions.set(sessionUri, existing);
            persistCurrentSessionSummary(existing);
            onEvent({
              type: "sessionSummaryChanged",
              session: existing,
              enrichment: enrichments.get(sessionUri),
              pendingInput: pendingInputs.get(sessionUri),
              workers: workersBySession.get(sessionUri),
            });
            const missingPlan = !enrichments.get(sessionUri)?.artifacts.some((a) => a.type === "plan");
            if (shouldEnrichSessionOnChange(
              previousStatus,
              existing.status,
              contentChanged,
              missingPlan && inputMayHaveChanged,
            )) {
              triggerEnrichment(sessionUri);
            }
          } else {
            // Re-evaluate skipped archived sessions when changes arrive
            const skipped = skippedArchived.get(sessionUri);
            if (skipped) {
              const { changes } = event.params;
              if (changes.changes !== undefined) {
                skipped.changes = {
                  additions: changes.changes.additions ?? 0,
                  deletions: changes.changes.deletions ?? 0,
                  files: changes.changes.files ?? 0,
                };
              }
              if (changes.status !== undefined) skipped.status = changes.status;
              if (shouldShowSession(skipped.status, skipped.changes?.files)) {
                debug("sessionChanged: promoting previously skipped archived session", sessionUri);
                skippedArchived.delete(sessionUri);
                sessions.set(sessionUri, skipped);
                persistCurrentSessionSummary(skipped);
                onEvent({ type: "sessionAdded", session: skipped });
              }
            }
          }
        }
      }
    } catch (err) {
      if (!disposed) {
        const message = err instanceof Error ? err.message : "Event stream error";
        warn("event loop error:", message);
        onEvent(classifyAhpError(err, "stream"));
      }
    }
  })();

  // Watch connection state for disconnection
  (async () => {
    for await (const state of client!.stateChanges()) {
      if (disposed) break;
      if (state.status === "closed") {
        const reason = state.reason.type === "transport"
          ? state.reason.error.message
          : "Connection closed";
        warn("disconnected:", reason);
        onEvent(classifyError(`Connection to AHP host lost: ${reason}`, "stream"));
        break;
      }
    }
  })();

  return dispose;
}
