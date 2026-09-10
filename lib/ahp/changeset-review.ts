import type {
  Changeset,
  ChangesetFile,
  ChangesetFilesReviewChangedAction,
  ChangesetState,
} from "@microsoft/agent-host-protocol";

import type { ChangesetReview } from "@/lib/types";

export function changesetFilesReviewChanged(
  files: string[],
  reviewed: boolean,
): ChangesetFilesReviewChangedAction {
  return {
    type: "changeset/filesReviewChanged" as ChangesetFilesReviewChangedAction["type"],
    files,
    reviewed,
  };
}

/** A session-wide changeset must be static before Planwerk can safely subscribe. */
export function isStaticChangesetUri(uri: string): boolean {
  return uri.length > 0 && !uri.includes("{") && !uri.includes("}");
}

/** AHP capability flags are presence-based, including an empty object. */
export function changesetSupportsReview(changeset: Changeset): boolean {
  const review = changeset.capabilities?.review;
  return review !== undefined && review !== null;
}

/**
 * Convert protocol review state into card-safe data.
 * Missing `reviewed` is explicitly normalized to false per the AHP spec.
 */
export function changesetReviewSummary(
  changeset: Changeset,
  files: ChangesetFile[],
): ChangesetReview {
  return {
    changesetUri: changeset.uriTemplate,
    capabilities: { review: changesetSupportsReview(changeset) },
    files: files.map((file) => ({
      id: file.id,
      reviewed: isChangesetFileReviewed(file),
    })),
  };
}

/** Missing `reviewed` is explicitly false in the AHP review contract. */
export function isChangesetFileReviewed(file: ChangesetFile): boolean {
  return file.reviewed === true;
}

/** Return a changeset snapshot only when it is safe to offer review mutations. */
export function readyChangesetReviewSummary(
  changeset: Changeset,
  state: ChangesetState | undefined,
): ChangesetReview | undefined {
  if (!state || state.status !== "ready") return undefined;
  return changesetReviewSummary(changeset, state.files);
}
