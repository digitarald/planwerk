import type { AhpClient } from "@microsoft/agent-host-protocol/client";
import type {
  ChangesetFile,
  Changeset,
} from "@microsoft/agent-host-protocol";
import { createHash } from "node:crypto";

import type { Artifact, ArtifactType, ChangesetReview, FileChange } from "@/lib/types";

import { readChatState, readSessionState } from "./snapshot";
import { readReadyChangesetState } from "./changeset-readiness";
import { readTextResource } from "./resource-read";
import { changesetReviewSummary, isChangesetFileReviewed } from "./changeset-review";
import { extractLastAgentMessage } from "./response-parts";

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
  /** Session-scoped diff totals, summed from the `changeKind: "session"` changeset
   *  (isolated per agent). Present only when `changesetVerified` is true. */
  additions: number;
  deletions: number;
  /** True when the counts above came from a *ready* session-scoped changeset (not
   *  computing/error, and the session actually exposes a changeset). Callers use
   *  this to decide whether the counts are trustworthy vs. the shared summary. */
  changesetVerified: boolean;
  /** Opaque freshness ref for the plan artifact content (`plan:<hash>`), when a
   *  plan with content is present. */
  planContentHash?: string;
  lastAgentMessage?: string;
  planContent?: string;
  /** Selected channel and AHP 0.6 review facts; informational only. */
  changesetReview?: ChangesetReview;
}

/** Stable, short freshness ref for plan content. Whitespace-insensitive so
 *  cosmetic reflows don't invalidate a passed plan review. */
export function hashPlanContent(content: string): string {
  const normalized = content.replace(/\s+/g, " ").trim();
  const digest = createHash("sha1").update(normalized).digest("hex").slice(0, 12);
  return `plan:${digest}`;
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
 */
export function findSessionChangeset(changesets: Changeset[]): Changeset | undefined {
  return changesets.find((changeset) => changeset.changeKind === "session");
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
      // No changeset catalogue — counts are unknown (not a verified zero).
      // Return agent message even without changeset data.
      return lastAgentMessage
        ? { artifacts: [], codeFileCount: 0, totalFileCount: 0, fileChanges: [], additions: 0, deletions: 0, changesetVerified: false, lastAgentMessage }
        : null;
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

    const csState = await readReadyChangesetState(client, changesetUri);
    if (!csState?.files) {
      debug("changeset has no files:", changesetUri);
      // Files not readable — treat as unknown, not a verified zero.
      return { artifacts: [], codeFileCount: 0, totalFileCount: 0, fileChanges: [], additions: 0, deletions: 0, changesetVerified: false, lastAgentMessage };
    }

    // Classify files
    const artifacts: Artifact[] = [];
    const fileChanges: FileChange[] = [];
    let codeFileCount = 0;
    let additions = 0;
    let deletions = 0;
    const artifactFiles: Array<{ file: ChangesetFile; path: string; type: ArtifactType }> = [];

    for (const file of csState.files) {
      const filePath = extractFilePath(file);
      const added = file.edit.diff?.added ?? 0;
      const removed = file.edit.diff?.removed ?? 0;
      additions += added;
      deletions += removed;
      fileChanges.push({
        id: file.id,
        path: filePath,
        added,
        removed,
        reviewed: isChangesetFileReviewed(file),
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
    const planContentHash = planContent ? hashPlanContent(planContent) : undefined;

    return {
      artifacts,
      codeFileCount,
      totalFileCount: csState.files.length,
      fileChanges,
      additions,
      deletions,
      changesetVerified: true,
      planContentHash,
      lastAgentMessage,
      planContent,
      changesetReview: changesetReviewSummary(changeset, csState.files),
    };
  } catch (err) {
    debug("enrichment failed for", sessionUri, err);
    return null;
  }
}
