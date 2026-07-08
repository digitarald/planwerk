import type { AhpClient } from "@microsoft/agent-host-protocol/client";
import type {
  ChangesetState,
  ChangesetFile,
  Changeset,
  Turn,
  ResponsePart,
} from "@microsoft/agent-host-protocol";

import { Artifact, ArtifactType, FileChange } from "@/lib/types";

import { readChatState, readSessionState } from "./snapshot";
import { readTextResource } from "./resource-read";

const LOG_PREFIX = "[ahp:changeset]";
const debug = (...args: unknown[]) => {
  if (process.env.AHP_DEBUG) console.debug(LOG_PREFIX, ...args);
};

/** Patterns that indicate non-code files (session artifacts, temp, etc.) */
const NON_CODE_PATTERNS = [
  /^\.copilot\//,
  /\/\.copilot\//,
  /\/session-state\//,
  /\/plan\.md$/,
  /\/research\.md$/,
  /\/spec\.md$/,
  /\/specification\.md$/,
  /\/design\.md$/,
  /\/decision\.md$/,
  /\/test-plan\.md$/,
  /\.tmp$/,
  /^\/tmp\//,
];

/** File path patterns → artifact types */
const ARTIFACT_FILE_PATTERNS: Array<{ pattern: RegExp; type: ArtifactType }> = [
  { pattern: /\/plan\.md$/i, type: "plan" },
  { pattern: /plan\.md$/i, type: "plan" },
  { pattern: /\/research\.md$/i, type: "research" },
  { pattern: /\/spec\.md$/i, type: "spec" },
  { pattern: /\/specification\.md$/i, type: "spec" },
  { pattern: /\/design\.md$/i, type: "design" },
  { pattern: /\/decision\.md$/i, type: "decision" },
  { pattern: /\/test-plan\.md$/i, type: "test-plan" },
];

export interface ChangesetEnrichment {
  artifacts: Artifact[];
  codeFileCount: number;
  totalFileCount: number;
  fileChanges: FileChange[];
  lastAgentMessage?: string;
  planContent?: string;
}

const MAX_AGENT_MESSAGE_LENGTH = 2000;

/**
 * Extract the last agent response from completed turns.
 * Takes only the trailing markdown parts after the final tool call,
 * which represents the agent's concluding response to the user.
 */
function extractLastAgentMessage(turns: Turn[]): string | undefined {
  if (!turns.length) return undefined;

  // Walk backwards to find the last turn with markdown content
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i];
    const parts = turn.responseParts;
    if (!parts?.length) continue;

    // Find the index of the last tool call part
    let lastToolIdx = -1;
    for (let j = parts.length - 1; j >= 0; j--) {
      if (parts[j].kind === "toolCall") {
        lastToolIdx = j;
        break;
      }
    }

    // Collect markdown parts after the last tool call (the final response)
    const trailingMarkdown = parts
      .slice(lastToolIdx + 1)
      .filter((p: ResponsePart) => p.kind === "markdown")
      .map((p) => ("content" in p ? (p.content as string) : ""))
      .join("")
      .trim();

    if (trailingMarkdown) {
      return trailingMarkdown.slice(0, MAX_AGENT_MESSAGE_LENGTH);
    }

    // Fallback: if no tool calls at all, use the last markdown part
    const allMarkdown = parts
      .filter((p: ResponsePart) => p.kind === "markdown");
    if (allMarkdown.length) {
      const last = allMarkdown[allMarkdown.length - 1];
      const text = "content" in last ? (last.content as string).trim() : "";
      if (text) return text.slice(0, MAX_AGENT_MESSAGE_LENGTH);
    }
  }

  return undefined;
}

function isNonCodeFile(filePath: string): boolean {
  return NON_CODE_PATTERNS.some((p) => p.test(filePath));
}

function classifyArtifactFile(filePath: string): ArtifactType | null {
  for (const { pattern, type } of ARTIFACT_FILE_PATTERNS) {
    if (pattern.test(filePath)) return type;
  }
  return null;
}

function extractFilePath(file: ChangesetFile): string {
  // Use after.uri for creates/edits, before.uri for deletions
  const uri = file.edit.after?.uri ?? file.edit.before?.uri ?? file.id;
  // Strip scheme prefix (file://, ahp-session://<id>/content/, etc.)
  try {
    const url = new URL(uri);
    return url.pathname;
  } catch {
    return uri;
  }
}

function titleFromPath(filePath: string): string {
  const basename = filePath.split("/").pop() ?? filePath;
  // Capitalize and remove extension for display
  const name = basename.replace(/\.md$/i, "");
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/**
 * Find the session-level changeset from a session's changeset catalogue.
 * Prefers changeKind "session", falls back to first static URI (no template vars).
 */
function findSessionChangeset(changesets: Changeset[]): Changeset | undefined {
  // Prefer explicit session-kind changeset
  const sessionKind = changesets.find((c) => c.changeKind === "session");
  if (sessionKind) return sessionKind;

  // Fall back to first static URI (no {variables})
  return changesets.find((c) => !c.uriTemplate.includes("{"));
}

/**
 * Enrich a session card with changeset data — file classification and artifact content.
 *
 * Subscribes to the session, finds its changeset catalogue, subscribes to the
 * session changeset, classifies files, and fetches artifact markdown content.
 */
export async function enrichFromChangeset(
  client: AhpClient,
  sessionUri: string
): Promise<ChangesetEnrichment | null> {
  try {
    // Read the session snapshot to get its changeset catalogue.
    const sessionState = await readSessionState(client, sessionUri);

    // Extract last agent message. Turns live on the chat channel, so read from
    // the session's defaultChat. `ChatState.turns` is a tail window that already
    // contains the most recent turns (older turns page in via `turnsNextCursor`),
    // which is all we need for the latest agent message.
    let lastAgentMessage: string | undefined;
    const defaultChatUri = sessionState?.defaultChat;
    if (defaultChatUri) {
      try {
        const chatState = await readChatState(client, defaultChatUri);
        if (chatState?.turns?.length) {
          lastAgentMessage = extractLastAgentMessage(chatState.turns);
        }
      } catch {
        debug("chat subscribe failed for agent message extraction:", sessionUri);
      }
    }

    if (!sessionState?.changesets?.length) {
      debug("no changesets for", sessionUri);
      // Return agent message even without changeset data
      return lastAgentMessage ? { artifacts: [], codeFileCount: 0, totalFileCount: 0, fileChanges: [], lastAgentMessage } : null;
    }

    const changeset = findSessionChangeset(sessionState.changesets);
    if (!changeset) {
      debug("no session-level changeset found for", sessionUri);
      return null;
    }

    // The uriTemplate for static changesets IS the subscribable URI
    const changesetUri = changeset.uriTemplate;
    if (changesetUri.includes("{")) {
      debug("skipping templated changeset URI:", changesetUri);
      return null;
    }

    // Subscribe to the changeset to get file list
    const { result: csResult, subscription: csSub } =
      await client.subscribe(changesetUri);
    csSub.close();
    await client.unsubscribe(changesetUri).catch(() => {});

    const csState = csResult.snapshot?.state as ChangesetState | undefined;
    if (!csState?.files) {
      debug("changeset has no files:", changesetUri);
      return { artifacts: [], codeFileCount: 0, totalFileCount: 0, fileChanges: [], lastAgentMessage };
    }

    // If changeset is still computing, or failed, return null to retry later.
    // Files may be stale/partial in either status (error's cause is in
    // ChangesetState.error, not usable here).
    if (csState.status === "computing" || csState.status === "error") {
      debug("changeset not ready (status:", csState.status, "):", changesetUri);
      return null;
    }

    // Classify files
    const artifacts: Artifact[] = [];
    const fileChanges: FileChange[] = [];
    let codeFileCount = 0;
    const artifactFiles: Array<{ file: ChangesetFile; path: string; type: ArtifactType }> = [];

    for (const file of csState.files) {
      const filePath = extractFilePath(file);
      fileChanges.push({
        path: filePath,
        added: file.edit.diff?.added ?? 0,
        removed: file.edit.diff?.removed ?? 0,
      });
      const artifactType = classifyArtifactFile(filePath);

      if (artifactType && file.edit.after) {
        artifactFiles.push({ file, path: filePath, type: artifactType });
      } else if (!isNonCodeFile(filePath)) {
        codeFileCount++;
      }
    }

    // Fetch content for artifact files (parallel, with timeout protection)
    const contentPromises = artifactFiles.map(async ({ file, path, type }) => {
      let contentRef: string | undefined;

      if (file.edit.after?.content?.uri) {
        try {
          contentRef = await readTextResource(client, file.edit.after.content.uri);
        } catch (err) {
          debug("failed to read content for", path, err);
        }
      }

      const artifact: Artifact = {
        id: `cs-${file.id}`,
        type,
        title: titleFromPath(path),
        contentRef,
        createdAt: Date.now(),
        createdBy: "agent",
        status: "draft",
      };
      return artifact;
    });

    const resolvedArtifacts = await Promise.all(contentPromises);
    artifacts.push(...resolvedArtifacts);

    debug(
      sessionUri,
      `→ ${artifacts.length} artifacts, ${codeFileCount} code files, ${csState.files.length} total`
    );

    // Extract plan content from the first plan artifact that has it
    const planContent = artifacts.find((a) => a.type === "plan" && a.contentRef)?.contentRef;

    return {
      artifacts,
      codeFileCount,
      totalFileCount: csState.files.length,
      fileChanges,
      lastAgentMessage,
      planContent,
    };
  } catch (err) {
    debug("enrichment failed for", sessionUri, err);
    return null;
  }
}
