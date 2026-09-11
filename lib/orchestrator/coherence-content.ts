import "server-only";

import type {
  ChangesetFile,
  Changeset,
} from "@microsoft/agent-host-protocol";

import { withAHPClient } from "@/lib/ahp/client-operation";
import { readReadyChangesetState } from "@/lib/ahp/changeset-readiness";
import { readTextResource } from "@/lib/ahp/resource-read";
import { readSessionState } from "@/lib/ahp/snapshot";
import type { CoherenceTier } from "@/lib/types";

const MAX_FILES_PER_CARD = 5;
const MAX_BYTES_PER_FILE = 8_000;
const READ_TIMEOUT_MS = 15_000;

export interface OverlapFileContent {
  path: string;
  content: string;
  truncated: boolean;
}

/** Content fetched for one card's side of an overlapping pair. */
export interface CardOverlapContent {
  sessionUri: string;
  files: OverlapFileContent[];
  /** True when the changeset couldn't be read at all (degraded evidence). */
  failed: boolean;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error("read timeout")), ms)),
  ]);
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
  const sessionKind = changesets.find((c) => c.changeKind === "session");
  if (sessionKind) return sessionKind;
  return changesets.find((c) => !c.uriTemplate.includes("{"));
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
  return (path) => overlapPaths.some((dir) => path.includes(`/${dir}/`) || path.startsWith(dir));
}

/**
 * Fetch the content of a card's overlapping files from its AHP session changeset.
 * Uses an exclusively owned AHP client for the complete read. Best-effort:
 * returns `failed: true` when the changeset can't be read so the caller can decide
 * how to treat degraded evidence (e.g. keep a high-risk pair blocked).
 */
export async function fetchOverlapContent(
  hostUrl: string,
  sessionUri: string,
  tier: CoherenceTier,
  overlapPaths: string[]
): Promise<CardOverlapContent> {
  const matcher = buildMatcher(tier, overlapPaths);

  try {
    return await withAHPClient(hostUrl, async (client) => {
      const sessionState = await withTimeout(
        readSessionState(client, sessionUri),
        READ_TIMEOUT_MS,
      );
      const changeset = sessionState?.changesets?.length
        ? findSessionChangeset(sessionState.changesets)
        : undefined;
      if (!changeset || changeset.uriTemplate.includes("{")) {
        return { sessionUri, files: [], failed: true };
      }

      const csState = await withTimeout(
        readReadyChangesetState(client, changeset.uriTemplate, READ_TIMEOUT_MS),
        READ_TIMEOUT_MS + 1_000,
      );
      if (!csState?.files) {
        return { sessionUri, files: [], failed: true };
      }

      const targets = csState.files
        .filter((f) => matcher(extractFilePath(f)))
        .slice(0, MAX_FILES_PER_CARD);

      const files: OverlapFileContent[] = [];
      for (const file of targets) {
        const path = extractFilePath(file);
        const contentUri = file.edit.after?.content?.uri;
        if (!contentUri) {
          files.push({ path, content: "(no content — file deleted or binary)", truncated: false });
          continue;
        }
        try {
          const raw = await withTimeout(
            readTextResource(client, contentUri),
            READ_TIMEOUT_MS,
          );
          const truncated = raw.length > MAX_BYTES_PER_FILE;
          files.push({ path, content: raw.slice(0, MAX_BYTES_PER_FILE), truncated });
        } catch {
          files.push({ path, content: "(failed to read content)", truncated: false });
        }
      }

      return { sessionUri, files, failed: false };
    });
  } catch {
    return { sessionUri, files: [], failed: true };
  }
}
