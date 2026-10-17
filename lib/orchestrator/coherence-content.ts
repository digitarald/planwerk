import "server-only";

import type {
  ChangesetFile,
  Changeset,
} from "@microsoft/agent-host-protocol";

import { withAHPClient } from "@/lib/ahp/client-operation";
import { readReadyChangesetState } from "@/lib/ahp/changeset-readiness";
import { readTextResource } from "@/lib/ahp/resource-read";
import { listAllSessions } from "@/lib/ahp/catalog";
import { shouldReadLiveSessionState } from "@/lib/ahp/session-read-policy";
import { withSessionState } from "@/lib/ahp/snapshot";
import type { CoherenceTier } from "@/lib/types";

const MAX_FILES_PER_CARD = 5;
const MAX_BYTES_PER_FILE = 8_000;
const READ_TIMEOUT_MS = 15_000;

export interface OverlapFileContent {
  path: string;
  content: string;
  truncated: boolean;
  deleted?: boolean;
}

/** Content fetched for one card's side of an overlapping pair. */
export type CardOverlapContent = {
  sessionUri: string;
  files: OverlapFileContent[];
} & (
  | { status: "ready"; failed: false }
  | {
      status: "deferred";
      failed: true;
      reason: "inactive-session" | "session-changeset-unavailable" |
        "changeset-unavailable" | "incomplete-files" | "file-content-unavailable" |
        "read-unavailable";
    }
);

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("read timeout")), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function extractFilePath(file: ChangesetFile): string {
  const uri = file.edit.after?.uri ?? file.edit.before?.uri ?? file.id;
  try {
    return new URL(uri).pathname;
  } catch {
    return uri;
  }
}

function findSessionChangeset(changesets: Changeset[]): Changeset | undefined {
  return changesets.find((c) => c.changeKind === "session" && !c.uriTemplate.includes("{"));
}

/**
 * Build a matcher for the files this card should contribute to the review.
 * - file tier: exact overlapping paths.
 * - module tier: any of the card's files whose path lies under a shared module dir.
 */
function buildMatcher(tier: CoherenceTier, overlapPaths: string[]): (path: string) => boolean {
  if (tier === "file") {
    const set = new Set(overlapPaths);
    return (path) => set.has(path);
  }
  return (path) => overlapPaths.some((dir) => path.includes(`/${dir}/`) || path.startsWith(`${dir}/`));
}

/**
 * Fetch the content of a card's overlapping files from its AHP session changeset.
 * Uses an exclusively owned AHP client for the complete read.
 * Unavailable or incomplete evidence is retryable, never a coherent verdict.
 * Background checks never restore cold sessions just to obtain that evidence.
 */
export async function fetchOverlapContent(
  hostUrl: string,
  sessionUri: string,
  tier: CoherenceTier,
  overlapPaths: string[]
): Promise<CardOverlapContent> {
  const matcher = buildMatcher(tier, overlapPaths);
  const deferred = (
    reason: Extract<CardOverlapContent, { status: "deferred" }>["reason"],
    files: OverlapFileContent[] = [],
  ): CardOverlapContent => ({ sessionUri, status: "deferred", failed: true, reason, files });

  try {
    return await withAHPClient(hostUrl, (client) => withTimeout((async () => {
      const summary = (await listAllSessions(client)).find((item) => item.resource === sessionUri);
      if (!summary || !shouldReadLiveSessionState(summary.status)) {
        return deferred("inactive-session");
      }
      return withSessionState(client, sessionUri, async (sessionState): Promise<CardOverlapContent> => {
        const changeset = sessionState?.changesets?.length
          ? findSessionChangeset(sessionState.changesets)
          : undefined;
        if (!changeset) {
          return deferred("session-changeset-unavailable");
        }

        const csState = await withTimeout(
          readReadyChangesetState(client, changeset.uriTemplate, READ_TIMEOUT_MS),
          READ_TIMEOUT_MS + 1_000,
        );
        if (!csState?.files) {
          return deferred("changeset-unavailable");
        }

        const targets = csState.files.filter((f) => matcher(extractFilePath(f)));
        if (targets.length === 0 || targets.length > MAX_FILES_PER_CARD ||
            (tier === "file" && overlapPaths.some((path) =>
              !targets.some((file) => extractFilePath(file) === path)))) {
          return deferred("incomplete-files");
        }

        const files: OverlapFileContent[] = [];
        for (const file of targets) {
          const path = extractFilePath(file);
          const deleted = !file.edit.after;
          const contentUri = deleted
            ? file.edit.before?.content?.uri
            : file.edit.after?.content?.uri;
          if (!contentUri) {
            return deferred("file-content-unavailable", files);
          }
          try {
            const raw = await withTimeout(
              readTextResource(client, contentUri),
              READ_TIMEOUT_MS,
            );
            const truncated = raw.length > MAX_BYTES_PER_FILE;
            files.push({ path, content: raw.slice(0, MAX_BYTES_PER_FILE), truncated, deleted });
            if (truncated) return deferred("incomplete-files", files);
          } catch {
            return deferred("file-content-unavailable", files);
          }
        }

        return { sessionUri, files, status: "ready", failed: false };
      });
    })(), READ_TIMEOUT_MS * (MAX_FILES_PER_CARD + 2)));
  } catch (error) {
    console.warn(
      "[coherence-content] Live overlap read unavailable:",
      sessionUri,
      error instanceof Error ? error.message : error,
    );
    return deferred("read-unavailable");
  }
}
