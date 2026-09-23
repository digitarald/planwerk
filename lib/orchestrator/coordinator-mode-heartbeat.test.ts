import assert from "node:assert/strict";
import { test } from "node:test";

import {
  COORDINATOR_MODES,
  coordinatorModeAllows,
  coordinatorReviewPolicy,
  type CoordinatorCapability,
  type CoordinatorMode,
} from "./coordinator-mode.ts";

const AUTONOMOUS_SIDE_EFFECTS: Record<
  CoordinatorCapability,
  readonly string[]
> = {
  observe: [
    "assess-risk",
    "surface-blocker",
    "detect-wip",
    "detect-coherence",
  ],
  verify: [
    "run-check",
    "inspect-artifact",
    "start-independent-review",
    "record-review-verdict",
  ],
  "review-edits": ["allow-reviewer-edits"],
  interact: [
    "answer-input",
    "approve-plan",
    "deliver-plan-feedback",
    "nudge-session",
  ],
  advance: ["advance-phase"],
};

function allowedEffects(mode: CoordinatorMode): string[] {
  return Object.entries(AUTONOMOUS_SIDE_EFFECTS).flatMap(
    ([capability, effects]) =>
      coordinatorModeAllows(mode, capability as CoordinatorCapability)
        ? effects
        : [],
  );
}

test("observe is read-only monitoring with no autonomous work", () => {
  assert.deepEqual(allowedEffects("observe"), [
    "assess-risk",
    "surface-blocker",
    "detect-wip",
    "detect-coherence",
  ]);
});

test("verify adds report-only checks and reviews", () => {
  const effects = allowedEffects("verify");
  assert.ok(effects.includes("run-check"));
  assert.ok(effects.includes("start-independent-review"));
  assert.ok(effects.includes("record-review-verdict"));
  assert.ok(!effects.includes("allow-reviewer-edits"));
  assert.ok(!effects.includes("answer-input"));
  assert.ok(!effects.includes("advance-phase"));
  assert.deepEqual(coordinatorReviewPolicy("verify"), {
    independent: true,
    allowEdits: false,
  });
});

test("only coordinate permits session changes and phase advancement", () => {
  for (const mode of COORDINATOR_MODES) {
    assert.equal(
      allowedEffects(mode).includes("answer-input"),
      mode === "coordinate",
    );
    assert.equal(
      allowedEffects(mode).includes("advance-phase"),
      mode === "coordinate",
    );
  }
  assert.deepEqual(coordinatorReviewPolicy("coordinate"), {
    independent: false,
    allowEdits: true,
  });
});
