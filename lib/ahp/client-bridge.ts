import { AhpClient } from "@microsoft/agent-host-protocol/client";
import type { SessionSummary, UsageInfo } from "@microsoft/agent-host-protocol";

import { AHPSessionSummary, AHPEvent, AHPStatus, shouldShowSession } from "./types";
import { classifyError, ConnectionError } from "./connection-error";
import { classifyAhpError } from "./rpc-error";
import { enrichFromChangeset, ChangesetEnrichment, hashPlanContent } from "./changeset-enricher";
import { fetchCopilotCliArtifacts, clearPlanCache } from "./plan-artifact";
import { fetchSessionModel, fetchSessionPrimaryWorkingDirectory } from "./session-config";
import { mapSessionInputNeeded } from "./map-session";
import { asChatState, asSessionState, readChatState, readSessionState } from "./snapshot";
import { upsertSessionCache, removeSessionCache, reconcileSessionCache, getCachedSessions, CLEAR_ENRICHMENT, type CachedSession } from "@/lib/db/session-cache";
import { TelemetryTapTransport } from "./telemetry-transport";
import { handleOtlpLogs, rotateLogs } from "./telemetry-logs";
import { listAllSessions } from "./catalog";
import { connectAhpTransport, type AhpEndpointDiagnostics } from "./endpoint";
import { initializeAhpClient } from "./initialize";
import { sessionWorkingDirectories } from "./working-directories";
import type { PendingInput, WorkerActivity } from "@/lib/types";
import { mapWorkerChats, retainInactiveWorkers, type WorkerChatSummary } from "./worker-activity";
import { getWorkerActivityHistory, recordWorkerActivity } from "@/lib/orchestrator/worker-activity-store";

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

/**
 * Maps an AHP SDK SessionSummary to Planwerk's AHPSessionSummary format.
 */
function mapSdkSession(summary: SessionSummary): AHPSessionSummary {
  const mapped: AHPSessionSummary = {
    resource: summary.resource,
    provider: summary.provider,
    title: summary.title,
    status: summary.status,
    createdAt: new Date(summary.createdAt).toISOString(),
    modifiedAt: new Date(summary.modifiedAt).toISOString(),
  };

  if (summary.activity) {
    mapped.activity = summary.activity;
  }
  if (summary.project) {
    mapped.project = { name: summary.project.displayName, path: summary.project.uri };
  }
  if (summary.workingDirectory) {
    mapped.workingDirectory = summary.workingDirectory;
  }
  const workingDirectories = sessionWorkingDirectories(summary);
  if (workingDirectories) mapped.workingDirectories = workingDirectories;
  if (summary.changes) {
    mapped.changes = {
      additions: summary.changes.additions ?? 0,
      deletions: summary.changes.deletions ?? 0,
      files: summary.changes.files ?? 0,
    };
  }

  return mapped;
}

/**
 * A stable fingerprint of a session summary, used to decide whether a session has
 * *meaningfully* changed since it was last cached.
 *
 * Deliberately excludes `modifiedAt`: Copilot CLI bumps `modifiedAt` whenever a
 * session is merely resumed — including by our own reads (subscribing to a session
 * resumes it). So `modifiedAt` is not a reliable "did real work happen" signal.
 * Status and change counts are. When two signatures match, a moved `modifiedAt` is
 * a spurious resume bump we should ignore.
 */
function sessionSignature(summary: AHPSessionSummary): string {
  const c = summary.changes;
  return [
    summary.status,
    summary.title ?? "",
    c?.files ?? 0,
    c?.additions ?? 0,
    c?.deletions ?? 0,
  ].join("|");
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
export async function createAHPBridge({ hostUrl, onEvent, signal }: AHPBridgeOptions): Promise<() => void> {
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
  const workerCompletedUsageByChat = new Map<string, NonNullable<WorkerActivity["usage"]>>();
  const workerUsageObservers = new Map<string, { sessionUri: string; close: () => void }>();

  let disposed = false;
  let client: AhpClient | null = null;

  function dispose() {
    if (disposed) return;
    disposed = true;
    clearPlanCache();
    pendingInputs.clear();
    workersBySession.clear();
    workerChatsBySession.clear();
    for (const observer of workerObservers.values()) observer.close();
    workerObservers.clear();
    for (const observer of workerUsageObservers.values()) observer.close();
    workerUsageObservers.clear();
    workerUsageByChat.clear();
    workerCompletedUsageByChat.clear();
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

  function triggerEnrichment(sessionUri: string) {
    if (disposed || !client) return;

    const session = sessions.get(sessionUri);
    if (!session) return;

    // If already in-flight, mark dirty for re-enrichment after completion
    if (pendingEnrichments.has(sessionUri)) {
      dirtyEnrichments.add(sessionUri);
      return;
    }

    pendingEnrichments.add(sessionUri);

    const hasFileChanges = (session.changes?.files ?? 0) > 0;

    // Run changeset enrichment and session-state artifact fetch in parallel
    const changesetPromise = hasFileChanges
      ? enrichFromChangeset(client!, sessionUri)
      : Promise.resolve(null);
    const artifactPromise = fetchCopilotCliArtifacts(client!, sessionUri, session.modifiedAt);
    // The selected model is provider config on SessionState (not the summary), so
    // derive it once per session and cache it on the summary entry.
    const modelPromise: Promise<string | undefined> = session.model
      ? Promise.resolve(session.model)
      : fetchSessionModel(client!, sessionUri).catch(() => undefined);
    const primaryDirectoryPromise = fetchSessionPrimaryWorkingDirectory(client!, sessionUri)
      .catch(() => undefined);

    Promise.all([changesetPromise, artifactPromise, modelPromise, primaryDirectoryPromise])
      .then(([changesetResult, sessionArtifacts, model, primaryDirectory]) => {
        if (disposed || !sessions.has(sessionUri)) return;

        if (model) {
          const current = sessions.get(sessionUri);
          if (current && !current.model) current.model = model;
        }
        if (primaryDirectory) {
          const current = sessions.get(sessionUri);
          if (current) {
            current.primaryWorkingDirectory = primaryDirectory;
            current.workingDirectory = primaryDirectory;
          }
        }

        let enrichment = changesetResult ?? enrichments.get(sessionUri) ?? null;

        const mergedSessionArtifacts = sessionArtifacts.filter((artifact) => {
          const existing = enrichment?.artifacts.find(
            (candidate) => candidate.type === artifact.type
          );
          return (
            !existing ||
            (!existing.contentRef?.trim() && Boolean(artifact.contentRef?.trim()))
          );
        });
        if (mergedSessionArtifacts.length > 0) {
          const planArtifact = mergedSessionArtifacts.find(
            (artifact) => artifact.type === "plan"
          );
          const planContentHash = planArtifact?.contentRef
            ? hashPlanContent(planArtifact.contentRef)
            : undefined;
          if (enrichment) {
            const replacedTypes = new Set(
              mergedSessionArtifacts.map((artifact) => artifact.type)
            );
            enrichment = {
              ...enrichment,
              artifacts: [
                ...enrichment.artifacts.filter(
                  (artifact) => !replacedTypes.has(artifact.type)
                ),
                ...mergedSessionArtifacts,
              ],
              planContentHash: enrichment.planContentHash ?? planContentHash,
            };
          } else {
            enrichment = {
              artifacts: mergedSessionArtifacts,
              codeFileCount: 0,
              totalFileCount: 0,
              fileChanges: [],
              additions: 0,
              deletions: 0,
              changesetVerified: false,
              planContentHash,
            };
          }
        }

        // Clear stale enrichment when session has no file changes and no plan
        if (!hasFileChanges && !enrichment) {
          if (enrichments.has(sessionUri)) {
            enrichments.delete(sessionUri);
            upsertSessionCache(hostUrl, sessionUri, session, CLEAR_ENRICHMENT);
            onEvent({ type: "sessionSummaryChanged", session, enrichment: null });
          }
          return;
        }

        if (enrichment) {
          enrichments.set(sessionUri, enrichment);
          upsertSessionCache(hostUrl, sessionUri, sessions.get(sessionUri)!, enrichment);
        }
        // Re-emit with enrichment data included
        onEvent({
          type: "sessionSummaryChanged",
          session: sessions.get(sessionUri)!,
          enrichment: enrichment ?? null,
        });
      })
      .catch(() => {
        // Enrichment is best-effort; failures are silently ignored
      })
      .finally(() => {
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
    if (disposed || !client) return;

    // If already in-flight, mark dirty for re-fetch after completion
    if (pendingInputFetches.has(sessionUri)) {
      dirtyInputFetches.add(sessionUri);
      return;
    }

    pendingInputFetches.add(sessionUri);
    debug("fetchInput: subscribing", sessionUri);

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
    const s = sessions.get(sessionUri);
    return Boolean(s) && (s!.status & AHPStatus.InputNeeded) === AHPStatus.InputNeeded;
  };

  /**
   * Read a session's aggregated `SessionState.inputNeeded` (the AHP 0.5 session-level
   * input surface) and emit the most actionable pending input — an elicitation, a tool
   * confirmation, or a read-only client-execution blocker — across every chat.
   *
   * If the session reports InputNeeded but the snapshot's `inputNeeded` hasn't populated
   * yet (a race between the status flag and `session/inputNeededSet`), briefly wait for
   * that action, then re-read.
   */
  async function fetchInputFromSession(sessionUri: string) {
    if (disposed || !client) return;

    let sub: Awaited<ReturnType<typeof client.subscribe>> | undefined;
    try {
      sub = await client.subscribe(sessionUri);
    } catch (err) {
      warn("fetchInput: session subscribe failed", sessionUri, err instanceof Error ? err.message : err);
      emitNoPendingInput(sessionUri);
      return;
    }

    const { result, subscription } = sub;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      void subscription.close();
      client?.unsubscribe(sessionUri).catch(() => {});
    };

    try {
      if (disposed) return;

      // Re-check: status may have changed while the subscribe was in-flight.
      if (!stillInputNeeded(sessionUri)) {
        debug("fetchInput: no longer needed (status changed)", sessionUri);
        return;
      }

      const initial = mapSessionInputNeeded(asSessionState(result.snapshot)?.inputNeeded);
      if (initial) {
        emitPendingInput(sessionUri, initial);
        return;
      }

      // inputNeeded not populated yet — wait briefly for session/inputNeededSet.
      debug("fetchInput: no inputNeeded yet, waiting…", sessionUri);
      let sawSet = false;
      const timer = setTimeout(() => void subscription.close(), 5_000);
      try {
        for await (const event of subscription) {
          if (disposed) break;
          if (event.type !== "action") continue;
          if ((event.params.action.type as string) === "session/inputNeededSet") {
            sawSet = true;
            break;
          }
        }
      } finally {
        clearTimeout(timer);
      }

      // Close our streaming subscription before re-reading a fresh snapshot.
      release();
      if (sawSet && !disposed && stillInputNeeded(sessionUri)) {
        const fresh = await readSessionState(client!, sessionUri);
        const mapped = mapSessionInputNeeded(fresh?.inputNeeded);
        if (mapped) emitPendingInput(sessionUri, mapped);
        else emitNoPendingInput(sessionUri);
      }
    } finally {
      release();
    }
  }

  function emitPendingInput(sessionUri: string, mapped: PendingInput) {
    pendingInputs.set(sessionUri, mapped);
    debug("pending input:", sessionUri, mapped.requestId);
    const session = sessions.get(sessionUri)!;
    if (session) {
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

  function sameWorkerUsage(
    left: WorkerActivity["usage"],
    right: WorkerActivity["usage"],
  ): boolean {
    return (
      left?.inputTokens === right?.inputTokens
      && left?.outputTokens === right?.outputTokens
      && left?.cacheReadTokens === right?.cacheReadTokens
    );
  }

  function updateWorkerUsage(
    sessionUri: string,
    workerId: string,
    usage: NonNullable<WorkerActivity["usage"]>,
  ) {
    const previous = workerUsageByChat.get(workerId);
    if (sameWorkerUsage(previous, usage)) return;
    workerUsageByChat.set(workerId, usage);

    const current = workersBySession.get(sessionUri);
    if (!current?.some((worker) => worker.id === workerId)) return;
    emitWorkers(
      sessionUri,
      current.map((worker) => (
        worker.id === workerId ? { ...worker, usage } : worker
      )),
    );
  }

  function stopWorkerUsageObserver(workerId: string) {
    const observer = workerUsageObservers.get(workerId);
    if (!observer) return;
    workerUsageObservers.delete(workerId);
    observer.close();
    void client?.unsubscribe(workerId).catch(() => {});
  }

  async function observeWorkerUsage(
    sessionUri: string,
    workerId: string,
  ): Promise<WorkerActivity["usage"]> {
    const existing = workerUsageObservers.get(workerId);
    if (existing?.sessionUri === sessionUri) return workerUsageByChat.get(workerId);
    if (existing) stopWorkerUsageObserver(workerId);

    const { result, subscription } = await client!.subscribe(workerId);
    if (disposed) {
      subscription.close();
      void client!.unsubscribe(workerId).catch(() => {});
      return undefined;
    }

    const initialChat = asChatState(result.snapshot);
    const completedUsage = completedUsageFromChat(initialChat);
    const initialUsage = usageFromChat(initialChat);
    if (completedUsage) workerCompletedUsageByChat.set(workerId, completedUsage);
    if (initialUsage) workerUsageByChat.set(workerId, initialUsage);
    const observer = { sessionUri, close: () => subscription.close() };
    workerUsageObservers.set(workerId, observer);

    void (async () => {
      try {
        for await (const event of subscription) {
          if (
            disposed
            || workerUsageObservers.get(workerId) !== observer
            || event.type !== "action"
          ) {
            break;
          }
          const action = event.params.action as {
            type?: string;
            usage?: UsageInfo;
          };
          if (action.type === "chat/usage") {
            const usage = sumWorkerUsage([
              workerCompletedUsageByChat.get(workerId),
              toWorkerUsage(action.usage),
            ]);
            if (usage) updateWorkerUsage(sessionUri, workerId, usage);
          } else if (action.type === "chat/turnComplete") {
            const usage = workerUsageByChat.get(workerId);
            if (usage) workerCompletedUsageByChat.set(workerId, usage);
          }
        }
      } catch (err) {
        if (!disposed) {
          debug("worker usage observer failed:", workerId, err instanceof Error ? err.message : err);
        }
      } finally {
        if (workerUsageObservers.get(workerId) === observer) {
          workerUsageObservers.delete(workerId);
          void client?.unsubscribe(workerId).catch(() => {});
        }
      }
    })();

    return initialUsage;
  }

  async function applyWorkerChats(sessionUri: string, chats: readonly WorkerChatSummary[]) {
    const workers = mapWorkerChats(chats);
    const currentWorkerIds = new Set(workers.map((worker) => worker.id));
    for (const [workerId, observer] of workerUsageObservers) {
      if (observer.sessionUri === sessionUri && !currentWorkerIds.has(workerId)) {
        stopWorkerUsageObserver(workerId);
      }
    }

    await Promise.all(workers.map(async (worker) => {
      try {
        if (worker.isActive) {
          await observeWorkerUsage(sessionUri, worker.id);
        } else {
          const wasObserved = workerUsageObservers.has(worker.id);
          stopWorkerUsageObserver(worker.id);
          if (wasObserved || !workerUsageByChat.has(worker.id)) {
            const chat = await readChatState(client!, worker.id);
            const completedUsage = completedUsageFromChat(chat);
            const usage = usageFromChat(chat);
            if (completedUsage) workerCompletedUsageByChat.set(worker.id, completedUsage);
            if (usage) workerUsageByChat.set(worker.id, usage);
          }
        }
        worker.usage = workerUsageByChat.get(worker.id);
      } catch (err) {
        debug("worker usage read failed:", worker.id, err instanceof Error ? err.message : err);
      }
    }));
    for (const worker of workers) {
      recordWorkerActivity(sessionUri, worker.id, worker.activity);
      worker.history = getWorkerActivityHistory(sessionUri, worker.id);
    }
    emitWorkers(sessionUri, retainInactiveWorkers(workersBySession.get(sessionUri), workers));
  }

  function stopWorkerObserver(sessionUri: string) {
    for (const [workerId, observer] of workerUsageObservers) {
      if (observer.sessionUri === sessionUri) stopWorkerUsageObserver(workerId);
    }
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
      || (status & AHPStatus.InProgress) === 0
      || (status & AHPStatus.InputNeeded) === AHPStatus.InputNeeded
      || (status & AHPStatus.IsArchived) !== 0
    ) {
      stopWorkerObserver(sessionUri);
      return;
    }
    if (workerObservers.has(sessionUri)) return;

    try {
      const { result, subscription } = await client.subscribe(sessionUri);
      if (disposed) {
        subscription.close();
        void client.unsubscribe(sessionUri).catch(() => {});
        return;
      }
      const initial = asSessionState(result.snapshot);
      if (!initial) {
        subscription.close();
        void client.unsubscribe(sessionUri).catch(() => {});
        return;
      }

      workerObservers.set(sessionUri, subscription);
      workerChatsBySession.set(sessionUri, [...initial.chats]);
      await applyWorkerChats(sessionUri, initial.chats);

      void (async () => {
        try {
          for await (const event of subscription) {
            if (disposed || !workerObservers.has(sessionUri) || event.type !== "action") break;
            const action = event.params.action as {
              type?: string;
              summary?: WorkerChatSummary;
              chat?: string;
              changes?: Partial<WorkerChatSummary>;
            };
            const current = workerChatsBySession.get(sessionUri) ?? [];
            if (action.type === "session/chatAdded" && action.summary) {
              const next = [...current.filter((chat) => chat.resource !== action.summary!.resource), action.summary];
              workerChatsBySession.set(sessionUri, next);
              await applyWorkerChats(sessionUri, next);
            } else if (action.type === "session/chatUpdated" && action.chat && action.changes) {
              const next = current.map((chat) =>
                chat.resource === action.chat ? { ...chat, ...action.changes } : chat
              );
              workerChatsBySession.set(sessionUri, next);
              await applyWorkerChats(sessionUri, next);
            } else if (action.type === "session/chatRemoved" && action.chat) {
              const next = current.filter((chat) => chat.resource !== action.chat);
              workerChatsBySession.set(sessionUri, next);
              await applyWorkerChats(sessionUri, next);
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
      debug("worker activity read failed:", sessionUri, err instanceof Error ? err.message : err);
    }
  }

  if (signal) {
    signal.addEventListener("abort", dispose, { once: true });
  }

  // Connect WebSocket transport, wrapped with telemetry tap
  let endpoint: Awaited<ReturnType<typeof connectAhpTransport>>;
  try {
    endpoint = await connectAhpTransport(hostUrl);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to connect to AHP host";
    error("connect failed:", message);
    onEvent(classifyAhpError(err, "connect"));
    return dispose;
  }

  if (disposed) {
    endpoint.transport.close();
    return dispose;
  }

  // Rotate telemetry logs before the tap starts receiving to avoid data loss
  await rotateLogs().catch(() => {});

  const transport = new TelemetryTapTransport(endpoint.transport, (notification) => {
    handleOtlpLogs(notification);
  });

  client = new AhpClient(transport);
  client.connect();

  // Initialize the protocol
  let initResult;
  try {
    initResult = await initializeAhpClient(client, {
      initialSubscriptions: ["ahp-root://"],
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Protocol initialization failed";
    error("initialize failed:", message);
    onEvent(classifyAhpError(err, "protocol"));
    dispose();
    return dispose;
  }

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
      debug("telemetry logs subscription failed:", err instanceof Error ? err.message : err);
    });
  }

  // Fetch initial session list
  try {
    // Load the persisted cache so unchanged sessions can be hydrated from it
    // rather than re-read from the host. Reading a session over AHP *subscribes*
    // to it, which makes Copilot CLI lazily resume the session and bump its
    // modifiedAt — surfaced in VS Code as a reset "last modified" time. Reusing
    // the cache lets us resume each session at most once (on first sight or a real
    // change), eliminating the bulk timestamp thrash on every Planwerk restart.
    const cacheByUri = new Map<string, CachedSession>();
    try {
      for (const cached of getCachedSessions(hostUrl)) {
        cacheByUri.set(cached.sessionUri, cached);
      }
    } catch { /* cache read failure is non-fatal */ }

    // Sessions that are new or genuinely changed — only these get resume-causing
    // enrichment reads below. Unchanged sessions are served entirely from cache.
    const staleUris = new Set<string>();

    const allSummaries = await listAllSessions(client);

    for (const summary of allSummaries) {
      const mapped = mapSdkSession(summary);
      if (!shouldShowSession(summary.status, summary.changes?.files ?? 0)) {
        if (summary.status & AHPStatus.IsArchived) skippedArchived.set(summary.resource, mapped);
        continue;
      }

      const cached = cacheByUri.get(mapped.resource);
      const unchanged =
        cached && sessionSignature(cached.summary) === sessionSignature(mapped);

      if (unchanged) {
        // Session hasn't meaningfully changed since we cached it. A moved
        // modifiedAt is a spurious resume bump, so keep the stable cached value
        // (prevents the card from jumping), and hydrate derived data from cache
        // so we don't re-read — and thus resume — the session.
        mapped.modifiedAt = cached.summary.modifiedAt;
        if (cached.summary.model && !mapped.model) mapped.model = cached.summary.model;
        if (cached.enrichment) enrichments.set(mapped.resource, cached.enrichment);

        // Recover from a previously incomplete enrichment: if the session has file
        // changes but we never cached enrichment for it (enrichment failed, or the
        // process exited before it finished), re-enrich once so the card isn't left
        // permanently missing its changeset/plan/model.
        const hasFiles = (mapped.changes?.files ?? 0) > 0;
        if (hasFiles && !cached.enrichment) staleUris.add(mapped.resource);
      } else {
        // New or genuinely changed. Enrich once (this also fetches the model). Do
        // NOT seed cached enrichment here: triggerEnrichment must compute it fresh
        // so it can also *clear* enrichment when the session no longer has file
        // changes (seeding a stale value would defeat that clear path).
        staleUris.add(mapped.resource);
      }

      sessions.set(summary.resource, mapped);
    }
    info(`loaded ${sessions.size} sessions (${allSummaries.length} total, archived without changes filtered); ${staleUris.size} new/changed`);
    onEvent({
      type: "init",
      sessions: Array.from(sessions.values()),
      enrichments,
      pendingInputs,
      workers: workersBySession,
      connection: {
        ...endpoint.diagnostics,
        protocolVersion: initResult.protocolVersion,
        totalSessions: allSummaries.length,
        visibleSessions: sessions.size,
        filteredSessions: allSummaries.length - sessions.size,
      },
    });

    // Cache all sessions and remove stale entries
    for (const [uri, session] of sessions) {
      upsertSessionCache(hostUrl, uri, session, enrichments.get(uri));
    }
    reconcileSessionCache(hostUrl, new Set(sessions.keys()));

    // Trigger async enrichment (changeset + plan artifact) for new/changed
    // sessions and for InputNeeded sessions still missing a plan artifact — a
    // plan confirmation is the moment plan.md is finalized, so a reload/restart
    // mid-confirmation must still fetch it. Enrichment subscribes to the session
    // and would resume it, but syncInputState already subscribes to InputNeeded
    // sessions (they're hot — the user is actively resolving them).
    for (const [uri, session] of sessions) {
      const isInputNeeded = (session.status & AHPStatus.InputNeeded) === AHPStatus.InputNeeded;
      const missingPlan = !enrichments.get(uri)?.artifacts.some((a) => a.type === "plan");
      if (staleUris.has(uri) || (isInputNeeded && missingPlan)) triggerEnrichment(uri);
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

        if (event.type === "sessionAdded") {
          const mapped = mapSdkSession(event.params.summary);
          if (!shouldShowSession(mapped.status, mapped.changes?.files)) {
            debug("sessionAdded: skipping archived without changes", mapped.resource);
            if (mapped.status & AHPStatus.IsArchived) skippedArchived.set(mapped.resource, mapped);
            continue;
          }
          sessions.set(event.params.summary.resource, mapped);
          upsertSessionCache(hostUrl, mapped.resource, mapped, enrichments.get(mapped.resource));
          debug("sessionAdded:", mapped.resource, mapped.title);
          onEvent({ type: "sessionAdded", session: mapped, enrichment: enrichments.get(mapped.resource) });
          triggerEnrichment(mapped.resource);
          syncInputState(mapped.resource, mapped.status);
          void syncWorkerActivity(mapped.resource, mapped.status);
        } else if (event.type === "sessionRemoved") {
          debug("sessionRemoved:", event.params.session);
          stopWorkerObserver(event.params.session);
          sessions.delete(event.params.session);
          removeSessionCache(hostUrl, event.params.session);
          clearPendingInput(event.params.session);
          onEvent({ type: "sessionRemoved", resource: event.params.session });
        } else if (event.type === "sessionSummaryChanged") {
          const { session: sessionUri, changes } = event.params;
          const existing = sessions.get(sessionUri);
          if (existing) {
            debug("sessionChanged:", sessionUri, Object.keys(changes).join(","));
            if (changes.title !== undefined) existing.title = changes.title;
            if (changes.status !== undefined) existing.status = changes.status;
            if (changes.activity !== undefined) existing.activity = changes.activity;
            if (changes.modifiedAt !== undefined) existing.modifiedAt = new Date(changes.modifiedAt).toISOString();
            if (changes.workingDirectory !== undefined) existing.workingDirectory = changes.workingDirectory;
            const changedDirectories = sessionWorkingDirectories(changes as SessionSummary);
            if (changedDirectories) existing.workingDirectories = changedDirectories;
            if (changes.project !== undefined) {
              existing.project = changes.project
                ? { name: changes.project.displayName, path: changes.project.uri }
                : undefined;
            }
            if (changes.changes !== undefined) {
              existing.changes = {
                additions: changes.changes.additions ?? 0,
                deletions: changes.changes.deletions ?? 0,
                files: changes.changes.files ?? 0,
              };
            }

            // Check if session became archived
            if (existing.status & AHPStatus.IsArchived) {
              stopWorkerObserver(sessionUri);
              clearPendingInput(sessionUri);
              if (shouldShowSession(existing.status, existing.changes?.files)) {
                debug("sessionArchived: keeping (has code changes)", sessionUri);
                sessions.set(sessionUri, existing);
                upsertSessionCache(hostUrl, sessionUri, existing, enrichments.get(sessionUri));
                onEvent({ type: "sessionSummaryChanged", session: existing, enrichment: enrichments.get(sessionUri) });
              } else {
                debug("sessionArchived: removing (no code changes)", sessionUri);
                sessions.delete(sessionUri);
                enrichments.delete(sessionUri);
                removeSessionCache(hostUrl, sessionUri);
                onEvent({ type: "sessionRemoved", resource: sessionUri });
              }
              continue;
            }

            // Sync input state when status changes
            if (changes.status !== undefined) {
              syncInputState(sessionUri, existing.status);
            } else if ((existing.status & AHPStatus.InputNeeded) === AHPStatus.InputNeeded) {
              // Refetch input if session is still InputNeeded but summary changed
              // (host may have replaced the input request without toggling status)
              fetchInputOnce(sessionUri);
            }
            void syncWorkerActivity(sessionUri, existing.status);

            sessions.set(sessionUri, existing);
            upsertSessionCache(hostUrl, sessionUri, existing, enrichments.get(sessionUri));
            onEvent({
              type: "sessionSummaryChanged",
              session: existing,
              enrichment: enrichments.get(sessionUri),
              pendingInput: pendingInputs.get(sessionUri),
              workers: workersBySession.get(sessionUri),
            });
            // Re-trigger enrichment if file changes updated, the session became
            // idle, or it's InputNeeded but has no plan artifact yet. InputNeeded
            // (24) is composite and carries the InProgress bit, so the "became
            // idle" guard alone skips the plan (re)fetch at the exact moment a
            // plan confirmation appears — and session-state plan.md lives outside
            // the git tree, so file counts don't move either. The missing-plan
            // guard scopes this to the case that matters and avoids re-enriching
            // once the plan is captured.
            const isInputNeeded = (existing.status & AHPStatus.InputNeeded) === AHPStatus.InputNeeded;
            const missingPlan = !enrichments.get(sessionUri)?.artifacts.some((a) => a.type === "plan");
            if (
              changes.changes !== undefined
              || (changes.status !== undefined && !(changes.status & AHPStatus.InProgress))
              || (isInputNeeded && missingPlan)
            ) {
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
                upsertSessionCache(hostUrl, sessionUri, skipped, enrichments.get(sessionUri));
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
