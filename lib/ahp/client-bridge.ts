import { AhpClient } from "@microsoft/agent-host-protocol/client";
import { WebSocketTransport } from "@microsoft/agent-host-protocol/ws";
import { SUPPORTED_PROTOCOL_VERSIONS } from "@microsoft/agent-host-protocol";
import type { SessionSummary } from "@microsoft/agent-host-protocol";

import { AHPSessionSummary, AHPEvent, AHPStatus } from "./types";

// Offer both SDK-supported versions and newer server versions we're compatible with
const OFFERED_PROTOCOL_VERSIONS = [...SUPPORTED_PROTOCOL_VERSIONS, "0.4.0"];

export type BridgeEvent =
  | { type: "init"; sessions: AHPSessionSummary[] }
  | AHPEvent
  | { type: "error"; message: string };

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

  let disposed = false;
  let client: AhpClient | null = null;

  function dispose() {
    if (disposed) return;
    disposed = true;
    client?.shutdown().catch(() => {});
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
    onEvent({ type: "error", message });
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
    onEvent({ type: "error", message });
    dispose();
    return dispose;
  }

  if (disposed) return dispose;

  info("connected to", hostUrl);

  // Fetch initial session list
  try {
    const result = await client.request("listSessions", { channel: "ahp-root://" });
    for (const summary of result.items) {
      if (summary.status & AHPStatus.IsArchived) continue;
      const mapped = mapSdkSession(summary);
      sessions.set(summary.resource, mapped);
    }
    info(`loaded ${sessions.size} sessions (${result.items.length} total, archived filtered)`);
    onEvent({ type: "init", sessions: Array.from(sessions.values()) });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to list sessions";
    error("listSessions failed:", message);
    onEvent({ type: "error", message });
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
          sessions.set(event.params.summary.resource, mapped);
          debug("sessionAdded:", mapped.resource, mapped.title);
          onEvent({ type: "sessionAdded", session: mapped });
        } else if (event.type === "sessionRemoved") {
          debug("sessionRemoved:", event.params.session);
          sessions.delete(event.params.session);
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
            sessions.set(sessionUri, existing);
            onEvent({ type: "sessionSummaryChanged", session: existing });
          }
        }
      }
    } catch (err) {
      if (!disposed) {
        const message = err instanceof Error ? err.message : "Event stream error";
        warn("event loop error:", message);
        onEvent({ type: "error", message });
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
        onEvent({ type: "error", message: `Connection to AHP host lost: ${reason}` });
        break;
      }
    }
  })();

  return dispose;
}
