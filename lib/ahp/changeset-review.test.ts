import assert from "node:assert/strict";
import test from "node:test";
import type { Changeset, ChangesetFile } from "@microsoft/agent-host-protocol";

import {
  changesetFilesReviewChanged,
  changesetReviewSummary,
  changesetSupportsReview,
  isStaticChangesetUri,
} from "./changeset-review.ts";

const reviewableChangeset = {
  label: "Session changes",
  uriTemplate: "ahp-changeset:/session-1",
  changeKind: "session",
  capabilities: { review: {} },
} as unknown as Changeset;

const files = [
  { id: "opaque-file-a", edit: {} },
  { id: "opaque-file-b", edit: {}, reviewed: true },
] as unknown as ChangesetFile[];

test("review summary preserves opaque IDs and normalizes missing state", () => {
  assert.deepEqual(changesetReviewSummary(reviewableChangeset, files), {
    changesetUri: "ahp-changeset:/session-1",
    capabilities: { review: true },
    files: [
      { id: "opaque-file-a", reviewed: false },
      { id: "opaque-file-b", reviewed: true },
    ],
  });
});

test("review summary treats the empty review capability as supported", () => {
  assert.equal(changesetSupportsReview(reviewableChangeset), true);
  assert.equal(
    changesetSupportsReview({
      label: "Plain changes",
      uriTemplate: "ahp-changeset:/plain",
      changeKind: "session",
    }),
    false,
  );
});

test("review action and static URI checks use the protocol wire shape", () => {
  assert.deepEqual(changesetFilesReviewChanged(["opaque-file-a"], true), {
    type: "changeset/filesReviewChanged",
    files: ["opaque-file-a"],
    reviewed: true,
  });
  assert.equal(isStaticChangesetUri("ahp-changeset:/session-1"), true);
  assert.equal(isStaticChangesetUri("ahp-changeset:/{turnId}"), false);
});
