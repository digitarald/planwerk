import assert from "node:assert/strict";
import test from "node:test";

import { resolveReviewPrompt } from "./review-prompt.ts";

test("uses the default review prompt when the risk has no override", () => {
  assert.equal(
    resolveReviewPrompt("/rubber-duck", { medium: "/review", high: "/review" }, "low"),
    "/rubber-duck"
  );
});

test("uses the configured prompt for medium and high risk", () => {
  const prompts = { medium: "/review medium", high: "/review high" };
  assert.equal(resolveReviewPrompt("/rubber-duck", prompts, "medium"), "/review medium");
  assert.equal(resolveReviewPrompt("/rubber-duck", prompts, "high"), "/review high");
});
