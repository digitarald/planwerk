import assert from "node:assert/strict";
import { test } from "node:test";

import { classifyArtifactFile, isNonCodeFile } from "./artifact-classification.ts";

test("review.md is a first-class non-code review artifact", () => {
  assert.equal(classifyArtifactFile("/session/review.md"), "review");
  assert.equal(classifyArtifactFile("review.md"), "review");
  assert.equal(isNonCodeFile("/session/review.md"), true);
});
