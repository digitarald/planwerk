import assert from "node:assert/strict";
import { test } from "node:test";

import type { Artifact } from "../types.ts";
import { hasReadableArtifact } from "./artifact-gate.ts";

const artifact = (contentRef?: string): Artifact => ({
  id: "review",
  type: "review",
  title: "Review",
  contentRef,
  createdAt: 0,
  createdBy: "agent",
  status: "draft",
});

test("review artifact gate requires readable content", () => {
  assert.equal(hasReadableArtifact(undefined, "review"), false);
  assert.equal(hasReadableArtifact([artifact()], "review"), false);
  assert.equal(hasReadableArtifact([artifact("   \n")], "review"), false);
  assert.equal(hasReadableArtifact([artifact("# Review\nReady")], "review"), true);
});

test("review artifact gate does not accept another artifact type", () => {
  assert.equal(
    hasReadableArtifact([{ ...artifact("# Plan"), type: "plan" }], "review"),
    false
  );
});
