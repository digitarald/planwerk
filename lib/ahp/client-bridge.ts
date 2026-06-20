import { AhpClient } from "@microsoft/agent-host-protocol/client";
import { WebSocketTransport } from "@microsoft/agent-host-protocol/ws";
import { SUPPORTED_PROTOCOL_VERSIONS } from "@microsoft/agent-host-protocol";
import type { SessionSummary, SessionState, SessionInputRequest } from "@microsoft/agent-host-protocol";

import { AHPSessionSummary, AHPEvent, AHPStatus, shouldShowSession } from "./types";
import { classifyError, ConnectionError } from "./connection-error";
import { enrichFromChangeset, ChangesetEnrichment } from "./changeset-enricher";
import { fetchCopilotCliPlan, clearPlanCache } from "./plan-artifact";
import { mapInputRequests } from "./map-session";
import { upsertSessionCache, removeSessionCache, reconcileSessionCache, getCachedSessions, CLEAR_ENRICHMENT } from "@/lib/db/session-cache";
import { TelemetryTapTransport } from "./telemetry-transport";
import { handleOtlpLogs, rotateLogs } from "./telemetry-logs";
import type { PendingInput } from "@/lib/types";

// Re-export for consumers that imported from here
export type { ConnectionErrorCode, ConnectionError } from "./connection-error";

// Offer both SDK-supported versions and newer server versions we're compatible with
const OFFERED_PROTOCOL_VERSIONS = [...SUPPORTED_PROTOCOL_VERSIONS, "0.4.0"];

export type BridgeEvent =
  | { type: "init"; sessions: AHPSessionSummary[]; enrichments: Map<string, ChangesetEnrichment>; pendingInputs: Map<string, PendingInput> }
  | (AHPEvent & { enrichment?: ChangesetEnrichment | null; pendingInput?: PendingInput | null })
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
  if (summary.model) {
    mapped.model = summary.model.id;
  }
  if (summary.agent) {
    mapped.agent = summary.agent.uri;
  }
  if (summary.workingDirectory) {
    mapped.workingDirectory = summary.workingDirectory;
  }
  if (summary.changes) {
    mapped.changes = {
      additions: summary.changes.additions ?? 0,
      deletions: summary.changes.deletions ?? 0,
      files: summary.changes.files ?? 0,
    };
  }

  return mapped;
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

  let disposed = false;
  let client: AhpClient | null = null;

  function dispose() {
    if (disposed) return;
    disposed = true;
    clearPlanCache();
    pendingInputs.clear();
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

    // Run changeset enrichment and plan fetch in parallel
    const changesetPromise = hasFileChanges
      ? enrichFromChangeset(client!, sessionUri)
      : Promise.resolve(null);
    const planPromise = fetchCopilotCliPlan(client!, sessionUri, session.modifiedAt);

    Promise.all([changesetPromise, planPromise])
      .then(([changesetResult, planArtifact]) => {
        if (disposed || !sessions.has(sessionUri)) return;

        let enrichment = changesetResult ?? enrichments.get(sessionUri) ?? null;

        // Merge plan artifact into enrichment if no plan was found in changeset
        if (planArtifact) {
          const hasPlan = enrichment?.artifacts.some((a) => a.type === "plan");
          if (!hasPlan) {
            if (enrichment) {
              enrichment = { ...enrichment, artifacts: [...enrichment.artifacts, planArtifact] };
            } else {
              enrichment = { artifacts: [planArtifact], codeFileCount: 0, totalFileCount: 0, fileChanges: [] };
            }
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
   * One-shot fetch of inputRequests for a session in InputNeeded state.
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

    client.subscribe(sessionUri)
      .then(async ({ result, subscription }) => {
        // Close session subscription immediately — we only need the snapshot
        void subscription.close();
        client?.unsubscribe(sessionUri).catch(() => {});

        if (disposed) return;

        // Re-check: status may have changed while the request was in-flight
        const currentSession = sessions.get(sessionUri);
        const stillNeeded = currentSession
          && (currentSession.status & AHPStatus.InputNeeded) === AHPStatus.InputNeeded;

        if (!stillNeeded) {
          debug("fetchInput: no longer needed (status changed)", sessionUri);
          return;
        }

        const sessionState = result.snapshot?.state as SessionState | undefined;
        if (!sessionState) {
          warn("fetchInput: subscribe returned no snapshot", sessionUri);
          return;
        }

        // Check if the session state directly has inputRequests (legacy model)
        if (sessionState.inputRequests?.length) {
          const mapped = mapInputRequests(sessionState.inputRequests);
          if (mapped) {
            emitPendingInput(sessionUri, mapped);
          }
          return;
        }

        // Chat-based model: subscribe to the chat channel to get inputRequests
        const stateAny = sessionState as unknown as Record<string, unknown>;
        const defaultChatUri = stateAny.defaultChat as string | undefined;
        if (!defaultChatUri) {
          warn("fetchInput: no inputRequests and no defaultChat URI", sessionUri);
          emitNoPendingInput(sessionUri);
          return;
        }

        await fetchInputFromChat(sessionUri, defaultChatUri);
      })
      .catch((err) => {
        warn("fetchInput: subscribe failed", sessionUri, err instanceof Error ? err.message : err);
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

  /** Subscribe to a chat channel to extract inputRequests. */
  async function fetchInputFromChat(sessionUri: string, chatUri: string) {
    if (disposed || !client) return;

    let chatSub: Awaited<ReturnType<typeof client.subscribe>> | undefined;
    try {
      chatSub = await client.subscribe(chatUri);
    } catch (err) {
      warn("fetchInput: chat subscribe failed", sessionUri, err instanceof Error ? err.message : err);
      emitNoPendingInput(sessionUri);
      return;
    }

    const { result, subscription } = chatSub;

    const chatState = result.snapshot?.state as Record<string, unknown> | undefined;
    if (chatState) {
      // Check for inputRequests directly in chat state
      if (chatState.inputRequests && Array.isArray(chatState.inputRequests) && chatState.inputRequests.length > 0) {
        void subscription.close();
        client?.unsubscribe(chatUri).catch(() => {});
        const mapped = mapInputRequests(chatState.inputRequests as SessionInputRequest[]);
        if (mapped) {
          emitPendingInput(sessionUri, mapped);
        } else {
          emitNoPendingInput(sessionUri);
        }
        return;
      }
    }

    // inputRequests not yet in snapshot — wait for the action to arrive
    debug("fetchInput: chat has no inputRequests yet, waiting…", sessionUri);
    const timer = setTimeout(() => {
      debug("fetchInput: timed out waiting for chat inputRequested", sessionUri);
      void subscription.close();
    }, 5_000);

    try {
      for await (const action of subscription) {
        if (disposed) break;
        const type = (action as { type?: string }).type;
        if (type === "session/inputRequested") {
          const request = (action as { request?: SessionInputRequest }).request;
          if (request) {
            debug("fetchInput: got inputRequested from chat stream", sessionUri);
            const mapped = mapInputRequests([request]);
            if (mapped) {
              emitPendingInput(sessionUri, mapped);
            }
            break;
          }
        }
      }
    } catch {
      // subscription closed or errored
    } finally {
      clearTimeout(timer);
      void subscription.close();
      client?.unsubscribe(chatUri).catch(() => {});
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

  if (signal) {
    signal.addEventListener("abort", dispose, { once: true });
  }

  // Connect WebSocket transport, wrapped with telemetry tap
  let rawTransport: Awaited<ReturnType<typeof WebSocketTransport.connect>>;
  try {
    rawTransport = await WebSocketTransport.connect(hostUrl);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to connect to AHP host";
    error("connect failed:", message);
    onEvent(classifyError(message, "connect"));
    return dispose;
  }

  if (disposed) {
    rawTransport.close();
    return dispose;
  }

  // Rotate telemetry logs before the tap starts receiving to avoid data loss
  await rotateLogs().catch(() => {});

  const transport = new TelemetryTapTransport(rawTransport, (notification) => {
    handleOtlpLogs(notification);
  });

  client = new AhpClient(transport);
  client.connect();

  // Initialize the protocol
  const clientId = crypto.randomUUID();
  let initResult;
  try {
    initResult = await client.initialize({
      clientId,
      protocolVersions: OFFERED_PROTOCOL_VERSIONS,
      initialSubscriptions: ["ahp-root://"],
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Protocol initialization failed";
    error("initialize failed:", message);
    onEvent(classifyError(message, "protocol"));
    dispose();
    return dispose;
  }

  if (disposed) return dispose;

  info("connected to", hostUrl);

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
    // Build a lookup of cached modifiedAt values so we can preserve stable
    // timestamps for archived sessions (AHP host may refresh modifiedAt on restart)
    const cachedModifiedAt = new Map<string, string>();
    try {
      for (const cached of getCachedSessions(hostUrl)) {
        cachedModifiedAt.set(cached.sessionUri, cached.summary.modifiedAt);
      }
    } catch { /* cache read failure is non-fatal */ }

    const result = await client.request("listSessions", { channel: "ahp-root://" });
    for (const summary of result.items) {
      const mapped = mapSdkSession(summary);
      if (!shouldShowSession(summary.status, summary.changes?.files ?? 0)) {
        if (summary.status & AHPStatus.IsArchived) skippedArchived.set(summary.resource, mapped);
        continue;
      }
      // For archived sessions, preserve the original modifiedAt from cache
      // to prevent timestamp thrashing when AHP host restarts
      if ((mapped.status & AHPStatus.IsArchived) !== 0) {
        const cachedTs = cachedModifiedAt.get(mapped.resource);
        if (cachedTs && new Date(cachedTs).getTime() < new Date(mapped.modifiedAt).getTime()) {
          mapped.modifiedAt = cachedTs;
        }
      }
      sessions.set(summary.resource, mapped);
    }
    info(`loaded ${sessions.size} sessions (${result.items.length} total, archived without changes filtered)`);
    onEvent({ type: "init", sessions: Array.from(sessions.values()), enrichments, pendingInputs });

    // Cache all sessions and remove stale entries
    for (const [uri, session] of sessions) {
      upsertSessionCache(hostUrl, uri, session, enrichments.get(uri));
    }
    reconcileSessionCache(hostUrl, new Set(sessions.keys()));

    // Trigger async enrichment (changeset + plan artifact) for all sessions
    for (const [uri, session] of sessions) {
      triggerEnrichment(uri);
      // Fetch input for input-needed sessions
      syncInputState(uri, session.status);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to list sessions";
    error("listSessions failed:", message);
    onEvent(classifyError(message, "protocol"));
    dispose();
    return dispose;
  }

  // Attach subscription to root channel (already subscribed via initialSubscriptions)
  const rootSub = client.attachSubscription("ahp-root://");

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
        } else if (event.type === "sessionRemoved") {
          debug("sessionRemoved:", event.params.session);
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
            if (changes.model !== undefined) existing.model = changes.model?.id;
            if (changes.agent !== undefined) existing.agent = changes.agent?.uri;
            if (changes.workingDirectory !== undefined) existing.workingDirectory = changes.workingDirectory;
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

            sessions.set(sessionUri, existing);
            upsertSessionCache(hostUrl, sessionUri, existing, enrichments.get(sessionUri));
            onEvent({
              type: "sessionSummaryChanged",
              session: existing,
              enrichment: enrichments.get(sessionUri),
              pendingInput: pendingInputs.get(sessionUri),
            });
            // Re-trigger enrichment if file changes updated or session became idle
            if (changes.changes !== undefined || (changes.status !== undefined && !(changes.status & AHPStatus.InProgress))) {
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
        onEvent(classifyError(message, "stream"));
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
