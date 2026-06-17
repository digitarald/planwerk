import { AhpClient } from "@microsoft/agent-host-protocol/client";
import { WebSocketTransport } from "@microsoft/agent-host-protocol/ws";
import { SUPPORTED_PROTOCOL_VERSIONS } from "@microsoft/agent-host-protocol";
import type { SessionSummary } from "@microsoft/agent-host-protocol";

import { AHPSessionSummary, AHPEvent, AHPStatus, shouldShowSession } from "./types";
import { classifyError, ConnectionError } from "./connection-error";
import { enrichFromChangeset, ChangesetEnrichment } from "./changeset-enricher";
import { upsertSessionCache, removeSessionCache, reconcileSessionCache, CLEAR_ENRICHMENT } from "@/lib/db/session-cache";

// Re-export for consumers that imported from here
export type { ConnectionErrorCode, ConnectionError } from "./connection-error";

// Offer both SDK-supported versions and newer server versions we're compatible with
const OFFERED_PROTOCOL_VERSIONS = [...SUPPORTED_PROTOCOL_VERSIONS, "0.4.0"];

export type BridgeEvent =
  | { type: "init"; sessions: AHPSessionSummary[]; enrichments: Map<string, ChangesetEnrichment> }
  | (AHPEvent & { enrichment?: ChangesetEnrichment | null })
  | ConnectionError;

const LOG_PREFIX = "[ahp:bridge]";
const debug = (...args: unknown[]) => {
  if (process.env.AHP_DEBUG) console.debug(LOG_PREFIX, ...args);
};
const info = (...args: unknown[]) => console.info(LOG_PREFIX, ...args);
const warn = (...args: unknown[]) => console.warn(LOG_PREFIX, ...args);
const error = (...args: unknown[]) => console.error(LOG_PREFIX, ...args);

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

  let disposed = false;
  let client: AhpClient | null = null;

  function dispose() {
    if (disposed) return;
    disposed = true;
    client?.shutdown().catch(() => {});
  }

  /**
   * Trigger async changeset enrichment for a session. On completion,
   * re-emits the card with enrichment data applied.
   */
  // Track sessions that changed while enrichment was in-flight
  const dirtyEnrichments = new Set<string>();

  function triggerEnrichment(sessionUri: string) {
    if (disposed || !client) return;

    const session = sessions.get(sessionUri);
    if (!session) return;

    // Clear stale enrichment when session has no file changes
    if (!session.changes?.files) {
      if (enrichments.has(sessionUri)) {
        enrichments.delete(sessionUri);
        upsertSessionCache(hostUrl, sessionUri, session, CLEAR_ENRICHMENT);
        onEvent({ type: "sessionSummaryChanged", session, enrichment: null });
      }
      return;
    }

    // If already in-flight, mark dirty for re-enrichment after completion
    if (pendingEnrichments.has(sessionUri)) {
      dirtyEnrichments.add(sessionUri);
      return;
    }

    pendingEnrichments.add(sessionUri);
    enrichFromChangeset(client, sessionUri)
      .then((result) => {
        if (disposed || !sessions.has(sessionUri)) return;
        if (result) {
          enrichments.set(sessionUri, result);
          upsertSessionCache(hostUrl, sessionUri, sessions.get(sessionUri)!, result);
        }
        // Re-emit with enrichment data included
        onEvent({
          type: "sessionSummaryChanged",
          session: sessions.get(sessionUri)!,
          enrichment: result ?? enrichments.get(sessionUri) ?? null,
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

  if (signal) {
    signal.addEventListener("abort", dispose, { once: true });
  }

  // Connect WebSocket transport
  let transport: Awaited<ReturnType<typeof WebSocketTransport.connect>>;
  try {
    transport = await WebSocketTransport.connect(hostUrl);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to connect to AHP host";
    error("connect failed:", message);
    onEvent(classifyError(message, "connect"));
    return dispose;
  }

  if (disposed) {
    transport.close();
    return dispose;
  }

  client = new AhpClient(transport);
  client.connect();

  // Initialize the protocol
  const clientId = crypto.randomUUID();
  try {
    await client.initialize({
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

  // Fetch initial session list
  try {
    const result = await client.request("listSessions", { channel: "ahp-root://" });
    for (const summary of result.items) {
      const mapped = mapSdkSession(summary);
      if (!shouldShowSession(summary.status, summary.changes?.files ?? 0)) {
        if (summary.status & AHPStatus.IsArchived) skippedArchived.set(summary.resource, mapped);
        continue;
      }
      sessions.set(summary.resource, mapped);
    }
    info(`loaded ${sessions.size} sessions (${result.items.length} total, archived without changes filtered)`);
    onEvent({ type: "init", sessions: Array.from(sessions.values()), enrichments });

    // Cache all sessions and remove stale entries
    for (const [uri, session] of sessions) {
      upsertSessionCache(hostUrl, uri, session, enrichments.get(uri));
    }
    reconcileSessionCache(hostUrl, new Set(sessions.keys()));

    // Trigger async changeset enrichment for all sessions with file changes
    for (const [uri] of sessions) {
      triggerEnrichment(uri);
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
        } else if (event.type === "sessionRemoved") {
          debug("sessionRemoved:", event.params.session);
          sessions.delete(event.params.session);
          removeSessionCache(hostUrl, event.params.session);
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

            sessions.set(sessionUri, existing);
            upsertSessionCache(hostUrl, sessionUri, existing, enrichments.get(sessionUri));
            onEvent({ type: "sessionSummaryChanged", session: existing, enrichment: enrichments.get(sessionUri) });
            // Re-trigger enrichment if file changes updated
            if (changes.changes !== undefined) {
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
