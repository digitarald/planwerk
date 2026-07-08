import "server-only";

import { homedir } from "os";
import { join } from "path";
import { pathToFileURL } from "url";

import type { AhpClient } from "@microsoft/agent-host-protocol/client";
import { RpcError } from "@microsoft/agent-host-protocol/client";
import { AhpErrorCodes } from "@microsoft/agent-host-protocol";

import type { Artifact } from "@/lib/types";
import { readTextResource } from "./resource-read";

const LOG_PREFIX = "[ahp:plan]";
const debug = (...args: unknown[]) => {
  if (process.env.AHP_DEBUG) console.debug(LOG_PREFIX, ...args);
};

const UUID_RE = /^copilotcli:\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/|$)/i;

// Negative cache: sessionUri → modifiedAt when plan.md was confirmed missing
const missingPlanCache = new Map<string, string>();


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
export async function fetchCopilotCliPlan(
  client: AhpClient,
  sessionUri: string,
  modifiedAt: string,
): Promise<Artifact | null> {
  const sessionId = extractSessionId(sessionUri);
  if (!sessionId) return null;

  // Skip if we already know this session has no plan at this modifiedAt
  const cachedMissAt = missingPlanCache.get(sessionUri);
  if (cachedMissAt === modifiedAt) return null;

  const planPath = join(homedir(), ".copilot", "session-state", sessionId, "plan.md");
  const planUri = pathToFileURL(planPath).toString();

  try {
    const content = await readTextResource(client, planUri);

    debug("found plan.md for", sessionUri, `(${content.length} chars)`);
    missingPlanCache.delete(sessionUri);

    return {
      id: "session-state-plan",
      type: "plan",
      title: "Plan",
      contentRef: content,
      createdAt: Date.now(),
      createdBy: "agent",
      status: "draft",
    };
  } catch (err) {
    // NotFound (-32008) is expected — most sessions don't have a plan.md.
    // Checked via the SDK's structured RpcError.code rather than sniffing
    // err.message for the numeric code as a substring.
    const isNotFound = err instanceof RpcError && err.code === AhpErrorCodes.NotFound;
    if (isNotFound) {
      missingPlanCache.set(sessionUri, modifiedAt);
    } else {
      debug("resourceRead failed for plan.md:", err instanceof Error ? err.message : err);
    }
    return null;
  }
}

/** Clear the negative cache (e.g., on reconnect). */
export function clearPlanCache(): void {
  missingPlanCache.clear();
}
