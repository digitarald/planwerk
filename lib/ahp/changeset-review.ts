import type {
  Changeset,
  ChangesetFile,
  ChangesetState,
} from "@microsoft/agent-host-protocol";

import type { ChangesetReview } from "@/lib/types";

/**
 * AHP 0.6 adds these fields, but Planwerk currently compiles against the
 * published 0.5 SDK. Keep the compatibility surface intentionally narrow.
 */
type Changeset06 = Changeset & {
  capabilities?: {
    review?: Record<string, never>;
  };
};

type ChangesetFile06 = ChangesetFile & {
  reviewed?: boolean;
};

/** The one client-dispatchable AHP 0.6 action Planwerk needs for review progress. */
export interface ChangesetFilesReviewChangedAction {
  type: "changeset/filesReviewChanged";
  files: string[];
  reviewed: boolean;
}

export function changesetFilesReviewChanged(
  files: string[],
  reviewed: boolean,
): ChangesetFilesReviewChangedAction {
  return { type: "changeset/filesReviewChanged", files, reviewed };
}

/** A session-wide changeset must be static before Planwerk can safely subscribe. */
export function isStaticChangesetUri(uri: string): boolean {
  return uri.length > 0 && !uri.includes("{") && !uri.includes("}");
}

/** AHP capability flags are presence-based, including an empty object. */
export function changesetSupportsReview(changeset: Changeset): boolean {
  const review = (changeset as Changeset06).capabilities?.review;
  return review !== undefined && review !== null;
}

/**
 * Convert the 0.5 SDK state plus its narrow 0.6 additions into card-safe data.
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

/** Missing `reviewed` is explicitly false in the AHP 0.6 review contract. */
export function isChangesetFileReviewed(file: ChangesetFile): boolean {
  return (file as ChangesetFile06).reviewed === true;
}

/** Return a changeset snapshot only when it is safe to offer review mutations. */
export function readyChangesetReviewSummary(
  changeset: Changeset,
  state: ChangesetState | undefined,
): ChangesetReview | undefined {
  if (!state || state.status !== "ready") return undefined;
  return changesetReviewSummary(changeset, state.files);
}
