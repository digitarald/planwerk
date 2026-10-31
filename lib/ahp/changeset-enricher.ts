import type { AhpClient } from "@microsoft/agent-host-protocol/client";
import type {
  ChangesetFile,
  Changeset,
  ChangesetState,
  ContentEncoding,
  SessionState,
} from "@microsoft/agent-host-protocol";
import { createHash } from "node:crypto";

import type {
  Artifact,
  ArtifactType,
  ChangesetReview,
  FileChange,
  SessionRuntimeError,
  SessionOutcomeEvidence,
} from "../types";

import { readSessionState } from "./snapshot";
import { readReadyChangesetState } from "./changeset-readiness";
import { readTextResource } from "./resource-read";
import { hashPlanContent, type PlanSource } from "./plan-source";
import { awaitAbortable } from "../abort";
export { hashPlanContent } from "./plan-source";
import { changesetReviewSummary, isChangesetFileReviewed } from "./changeset-review";
import { classifyArtifactFile, isNonCodeFile } from "./artifact-classification";
import { throwIfAborted } from "../abort";
import type { EvidenceCaptureBudget } from "./evidence-budget";

const LOG_PREFIX = "[ahp:changeset]";
const debug = (...args: unknown[]) => {
  if (process.env.AHP_DEBUG) console.debug(LOG_PREFIX, ...args);
};

export interface ChangesetEnrichment {
  evidenceCapture?: import("../types").EvidenceCapture;
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
  /** Actual captured before/after resource bytes and identities. Only deliberate
   * full evidence reads populate this; it does not prove ongoing freshness. */
  capturedFilesDigest?: string;
  /** Opaque freshness ref for the plan artifact content (`plan:<hash>`), when a
   *  plan with content is present. */
  planContentHash?: string;
  planSource?: PlanSource;
  lastAgentMessage?: string;
  outcomeEvidence?: SessionOutcomeEvidence;
  runtimeError?: SessionRuntimeError;
  planContent?: string;
  /** Selected channel and AHP review facts; informational only. */
  changesetReview?: ChangesetReview;
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
  sessionUri: string,
  providedSessionState?: SessionState,
): Promise<ChangesetEnrichment | null> {
  try {
    const sessionState = providedSessionState
      ?? await readSessionState(client, sessionUri);

    if (!sessionState?.changesets?.length) {
      debug("no changesets for", sessionUri);
      return null;
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
      return { artifacts: [], codeFileCount: 0, totalFileCount: 0, fileChanges: [], additions: 0, deletions: 0, changesetVerified: false };
    }

    return await enrichChangesetState(client, changeset, csState, false, undefined, undefined, sessionUri);
  } catch (err) {
    debug("enrichment failed for", sessionUri, err);
    return null;
  }
}

/** Compare resource bytes, not counts or tool names, across a report-only review. */
export async function readReviewSourceDigest(
  client: AhpClient,
  sessionUri: string,
  state: SessionState,
  budget: EvidenceCaptureBudget,
): Promise<string> {
  const changeset = findSessionChangeset(state.changesets ?? []);
  if (!changeset || changeset.uriTemplate.includes("{")) {
    throw new Error("A readable session changeset is required to verify report-only review.");
  }
  const current = await awaitAbortable(
    () => readReadyChangesetState(client, changeset.uriTemplate), budget.signal,
  );
  if (!current || current.status !== "ready") throw new Error("Review source evidence is unavailable.");
  const enrichment = await enrichChangesetState(client, changeset, current, true, budget.signal, budget, sessionUri);
  if (!enrichment.capturedFilesDigest) throw new Error("Review source bytes are unavailable.");
  return enrichment.capturedFilesDigest;
}

/** Classify an already-owned changeset, optionally capturing every file side. */
export async function enrichChangesetState(
  client: AhpClient,
  changeset: Changeset,
  csState: ChangesetState,
  captureEvidence = false,
  signal?: AbortSignal,
  budget?: EvidenceCaptureBudget,
  sessionUri?: string,
): Promise<ChangesetEnrichment> {
    if (csState.status !== "ready") throw new Error("Session changeset is not ready");
    budget?.assertFileCount(csState.files.length);
    const contents = new Map<string, Buffer>();
    const side = async (value: ChangesetFile["edit"]["after"]) => {
      if (!value) return null;
      if (!value.content?.uri) throw new Error("A changeset file has no readable content resource");
      throwIfAborted(signal);
      const result = await client.request("resourceRead", {
        channel: "ahp-root://", uri: value.content.uri,
        encoding: "base64" as ContentEncoding,
      });
      throwIfAborted(signal);
      const bytes = Buffer.from(result.data, result.encoding === "base64" ? "base64" : "utf-8");
      budget?.consumeDecodedBytes(bytes.length);
      contents.set(value.content.uri, bytes);
      return {
        uri: value.uri,
        contentUri: value.content.uri,
        nonce: value.content.nonce ?? null,
        contentType: value.content.contentType ?? null,
        digest: createHash("sha256").update(bytes).digest("hex"),
      };
    };
    const capturedFiles = captureEvidence
      ? await (async () => {
        const files = [];
        for (const file of csState.files) {
          if (!file.edit.before && !file.edit.after) throw new Error("A changeset file has neither side");
          files.push({
            id: file.id,
            before: await side(file.edit.before),
            after: await side(file.edit.after),
            added: file.edit.diff?.added ?? 0,
            removed: file.edit.diff?.removed ?? 0,
          });
        }

        return files;
      })()
      : undefined;
    const capturedFilesDigest = capturedFiles
      ? createHash("sha256")
        .update(JSON.stringify(capturedFiles.sort((a, b) => a.id.localeCompare(b.id))))
        .digest("hex")
      : undefined;

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
        if (captureEvidence) {
          contentRef = contents.get(file.edit.after.content.uri)?.toString("utf-8");
        } else {
          try {
            contentRef = await readTextResource(client, file.edit.after.content.uri);
          } catch (err) {
            debug("failed to read content for", path, err);
          }
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
      changeset.uriTemplate,
      `→ ${artifacts.length} artifacts, ${codeFileCount} code files, ${csState.files.length} total`
    );

    // Extract plan content from the first plan artifact that has it
    const plans = artifactFiles.filter((entry) => entry.type === "plan");
    const planContent = plans.length === 1
      ? artifacts.find((a) => a.type === "plan" && a.contentRef)?.contentRef : undefined;
    const planUri = plans.length === 1 ? plans[0].file.edit.after?.content?.uri : undefined;
    const planContentHash = planContent ? hashPlanContent(planContent) : undefined;

    return {
      artifacts,
      codeFileCount,
      totalFileCount: csState.files.length,
      fileChanges,
      additions,
      deletions,
      changesetVerified: true,
      capturedFilesDigest,
      planContentHash,
      planSource: planUri && sessionUri ? { sessionUri, uri: planUri } : undefined,
      planContent,
      changesetReview: changesetReviewSummary(changeset, csState.files),
    };
}
