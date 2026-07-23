import assert from "node:assert/strict";
import test from "node:test";

import { decideReviewAction } from "./review-decision.ts";

test("unresolved blockers re-iterate even when low-risk edits were made", () => {
  assert.equal(
    decideReviewAction(
      {
        status: "failed",
        summary: "A blocker remains.",
        findings: ["Missing authorization check."],
        madeEdits: true,
      },
      1,
      2,
      false
    ),
    "re-iterate"
  );
});

test("passed edits follow the configured re-review policy", () => {
  const verdict = {
    status: "passed" as const,
    summary: "No blockers remain.",
    findings: [],
    madeEdits: true,
  };

  assert.equal(decideReviewAction(verdict, 1, 2, true), "re-iterate");
  assert.equal(decideReviewAction(verdict, 1, 2, false), "passed");
  assert.equal(decideReviewAction(verdict, 2, 2, true), "passed");
});

test("ambiguous judgments always escalate", () => {
  assert.equal(
    decideReviewAction(
      {
        status: "needs-human",
        summary: "Evidence is ambiguous.",
        findings: [],
        madeEdits: false,
      },
      1,
      3,
      true
    ),
    "escalated"
  );
});
