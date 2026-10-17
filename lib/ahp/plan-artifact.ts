import "server-only";

import { homedir } from "os";
import { join } from "path";
import { pathToFileURL } from "url";

import type { AhpClient } from "@microsoft/agent-host-protocol/client";
import { RpcError } from "@microsoft/agent-host-protocol/client";
import { AhpErrorCodes } from "@microsoft/agent-host-protocol";

import type { Artifact } from "@/lib/types";
import { readTextResource } from "./resource-read";

const LOG_PREFIX = "[ahp:artifact]";
const debug = (...args: unknown[]) => {
  if (process.env.AHP_DEBUG) console.debug(LOG_PREFIX, ...args);
};

const UUID_RE = /^copilotcli:\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/|$)/i;

const SESSION_ARTIFACTS = [
  { filename: "plan.md", type: "plan", title: "Plan" },
  { filename: "review.md", type: "review", title: "Review" },
] as const;

// A bridge owns misses across its transient clients, never across hosts/reconnects.
const missingArtifactCache = new WeakMap<object, Map<string, string>>();


/**
 * Extract the root session UUID from a copilotcli:/ URI.
 * Returns null for non-copilotcli providers or malformed URIs.
 */
function extractSessionId(sessionUri: string): string | null {
  const match = UUID_RE.exec(sessionUri);
  return match ? match[1] : null;
}

/**
 * Attempt to read plan.md from a Copilot CLI session's session-state directory.
 *
 * This is a provider-specific fallback for sessions where plan.md lives in
 * ~/.copilot/session-state/{id}/ rather than in the git working tree.
 * Returns a plan Artifact with content, or null if no plan exists.
 */
async function fetchCopilotCliArtifact(
  client: AhpClient,
  sessionUri: string,
  modifiedAt: string,
  definition: (typeof SESSION_ARTIFACTS)[number],
  cacheOwner: object,
): Promise<Artifact | null> {
  const sessionId = extractSessionId(sessionUri);
  if (!sessionId) return null;

  const cacheKey = `${sessionUri}:${definition.filename}`;
  let misses = missingArtifactCache.get(cacheOwner);
  if (!misses) {
    misses = new Map();
    missingArtifactCache.set(cacheOwner, misses);
  }
  const cachedMissAt = misses.get(cacheKey);
  if (cachedMissAt === modifiedAt) return null;

  const artifactPath = join(
    homedir(),
    ".copilot",
    "session-state",
    sessionId,
    definition.filename
  );
  const artifactUri = pathToFileURL(artifactPath).toString();

  try {
    const content = await readTextResource(client, artifactUri);

    debug("found", definition.filename, "for", sessionUri, `(${content.length} chars)`);
    misses.delete(cacheKey);

    return {
      id: `session-state-${definition.type}`,
      type: definition.type,
      title: definition.title,
      contentRef: content,
      createdAt: Date.now(),
      createdBy: "agent",
      status: "draft",
    };
  } catch (err) {
    // NotFound (-32008) is expected — artifacts appear as the session progresses.
    // Checked via the SDK's structured RpcError.code rather than sniffing
    // err.message for the numeric code as a substring.
    const isNotFound = err instanceof RpcError && err.code === AhpErrorCodes.NotFound;
    if (isNotFound) {
      misses.set(cacheKey, modifiedAt);
    } else {
      debug(
        `resourceRead failed for ${definition.filename}:`,
        err instanceof Error ? err.message : err
      );
    }
    return null;
  }
}

export async function fetchCopilotCliArtifacts(
  client: AhpClient,
  sessionUri: string,
  modifiedAt: string,
  cacheOwner: object = client,
): Promise<Artifact[]> {
  const artifacts = await Promise.all(
    SESSION_ARTIFACTS.map((definition) =>
      fetchCopilotCliArtifact(client, sessionUri, modifiedAt, definition, cacheOwner)
    )
  );
  return artifacts.filter((artifact): artifact is Artifact => artifact !== null);
}

/** Backward-compatible single-artifact helper for existing callers/tests. */
export async function fetchCopilotCliPlan(
  client: AhpClient,
  sessionUri: string,
  modifiedAt: string,
): Promise<Artifact | null> {
  const artifacts = await fetchCopilotCliArtifacts(client, sessionUri, modifiedAt);
  return artifacts.find((artifact) => artifact.type === "plan") ?? null;
}
