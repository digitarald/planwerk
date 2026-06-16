import { AhpClient } from "@tylerl0706/ahpx";
import type { SessionSummary } from "@tylerl0706/ahpx";

import { AHPSessionSummary, AHPEvent, AHPStatus } from "./types";

// Use string values directly since const enums can't be accessed with isolatedModules
const NOTIFICATION_SESSION_ADDED = "root/sessionAdded";
const NOTIFICATION_SESSION_REMOVED = "root/sessionRemoved";
const NOTIFICATION_SESSION_SUMMARY_CHANGED = "root/sessionSummaryChanged";

const LOG_PREFIX = "[ahp:bridge]";
const debug = (...args: unknown[]) => {
  if (process.env.AHP_DEBUG) console.debug(LOG_PREFIX, ...args);
};
const info = (...args: unknown[]) => console.info(LOG_PREFIX, ...args);
const warn = (...args: unknown[]) => console.warn(LOG_PREFIX, ...args);
const error = (...args: unknown[]) => console.error(LOG_PREFIX, ...args);

export type BridgeEvent =
  | { type: "init"; sessions: AHPSessionSummary[] }
  | AHPEvent
  | { type: "error"; message: string };

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
  if (summary.changesets && summary.changesets.length > 0) {
    let additions = 0;
    let deletions = 0;
    for (const edit of summary.changesets) {
      if (edit.diff) {
        additions += edit.diff.added ?? 0;
        deletions += edit.diff.removed ?? 0;
      }
    }
    mapped.changes = { additions, deletions, files: summary.changesets.length };
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
  const client = new AhpClient({ initialSubscriptions: ["ahp-root://"] });
  const sessions = new Map<string, AHPSessionSummary>();

  let disposed = false;
  function dispose() {
    if (disposed) return;
    disposed = true;
    try {
      client.disconnect();
    } catch {
      // ignore disconnect errors
    }
  }

  if (signal) {
    signal.addEventListener("abort", dispose, { once: true });
  }

  try {
    await client.connect(hostUrl);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to connect to AHP host";
    error("connect failed:", message);
    onEvent({ type: "error", message });
    dispose();
    return dispose;
  }

  if (disposed) return dispose;

  info("connected to", hostUrl);

  // Fetch initial session list
  try {
    const result = await client.listSessions();
    for (const summary of result.items) {
      // Skip archived sessions
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

  // Listen for session notifications
  client.on("notification", (notification: { type: string; summary?: SessionSummary; session?: string; changes?: Partial<SessionSummary> }) => {
    if (disposed) return;

    if (notification.type === NOTIFICATION_SESSION_ADDED && notification.summary) {
      const mapped = mapSdkSession(notification.summary);
      sessions.set(notification.summary.resource, mapped);
      debug("sessionAdded:", mapped.resource, mapped.title);
      onEvent({ type: "sessionAdded", session: mapped });
    } else if (notification.type === NOTIFICATION_SESSION_REMOVED && notification.session) {
      debug("sessionRemoved:", notification.session);
      sessions.delete(notification.session);
      onEvent({ type: "sessionRemoved", resource: notification.session });
    } else if (notification.type === NOTIFICATION_SESSION_SUMMARY_CHANGED && notification.session && notification.changes) {
      const existing = sessions.get(notification.session);
      if (existing) {
        // Apply partial changes
        const changes = notification.changes;
        debug("sessionChanged:", notification.session, Object.keys(changes).join(","));
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
        if (changes.changesets !== undefined && changes.changesets.length > 0) {
          let additions = 0;
          let deletions = 0;
          for (const edit of changes.changesets) {
            if (edit.diff) {
              additions += edit.diff.added ?? 0;
              deletions += edit.diff.removed ?? 0;
            }
          }
          existing.changes = { additions, deletions, files: changes.changesets.length };
        }
        sessions.set(notification.session, existing);
        onEvent({ type: "sessionSummaryChanged", session: existing });
      }
    }
  });

  client.on("disconnected", () => {
    if (!disposed) {
      warn("disconnected from", hostUrl);
      onEvent({ type: "error", message: "Connection to AHP host lost" });
    }
  });

  client.on("error", (err: Error) => {
    if (!disposed) {
      error("client error:", err.message);
      onEvent({ type: "error", message: err.message || "AHP connection error" });
    }
  });

  return dispose;
}
