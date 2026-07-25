import assert from "node:assert/strict";
import test from "node:test";

import {
  formatPlanReviewFeedback,
  parsePlanReviewVerdict,
} from "./plan-review-core.ts";

test("parses a blocking plan review", () => {
  assert.deepEqual(
    parsePlanReviewVerdict(JSON.stringify({
      status: "failed",
      summary: "Two assumptions are unresolved.",
      findings: ["Verify the host capability.", "Cover stale requests."],
    })),
    {
      status: "failed",
      summary: "Two assumptions are unresolved.",
      findings: ["Verify the host capability.", "Cover stale requests."],
    },
  );
});

test("rejects inconsistent plan review verdicts", () => {
  assert.equal(parsePlanReviewVerdict('{"status":"passed","summary":"ok","findings":["blocker"]}'), null);
  assert.equal(parsePlanReviewVerdict('{"status":"failed","summary":"bad","findings":[]}'), null);
});

test("formats concrete findings as plan feedback", () => {
  const feedback = formatPlanReviewFeedback({
    status: "failed",
    summary: "The request flow is incomplete.",
    findings: ["Handle a stale request."],
  });
  assert.match(feedback, /independent rubber-duck review/i);
  assert.match(feedback, /- Handle a stale request\./);
  assert.match(feedback, /present it for approval again/i);
});
