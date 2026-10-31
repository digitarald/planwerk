import assert from "node:assert/strict";
import test from "node:test";

import { appendPlanReviewEvidence, resolveReviewPrompt } from "./review-prompt.ts";
import { hashPlanContent } from "../ahp/plan-source.ts";

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

test("independent review receives the complete 19,950-byte parent plan", () => {
  const heading = "# SDK / AHP adoption plan\n";
  const content = heading + "x".repeat(19_950 - Buffer.byteLength(heading));
  const source = { sessionUri: "ahp-session:/parent", uri: "file:///host/sdk-parent/plan.md", chatUri: "ahp-chat:/writer", turnId: "writer-turn", requestId: "request" };
  const prompt = appendPlanReviewEvidence("/rubber-duck the plan", {
    content, source, changesetRef: hashPlanContent(content),
  });
  assert(prompt.startsWith("/rubber-duck the plan\n"));
  assert(prompt.includes(content));
  assert(prompt.includes("Do not edit any files or run mutating commands"));
  assert(prompt.includes(JSON.stringify(source)));
  assert(prompt.includes(hashPlanContent(content)));
});
