import assert from "node:assert/strict";
import { test } from "node:test";

import {
  COORDINATOR_MODES,
  DEFAULT_COORDINATOR_MODE,
  coordinatorModeAllows,
  isCoordinatorMode,
  isCoordinatorModeEscalation,
  type CoordinatorCapability,
  type CoordinatorMode,
} from "./coordinator-mode.ts";

const expected: Record<
  CoordinatorMode,
  Record<CoordinatorCapability, boolean>
> = {
  observe: {
    observe: true,
    verify: false,
    "review-edits": false,
    interact: false,
    advance: false,
  },
  verify: {
    observe: true,
    verify: true,
    "review-edits": false,
    interact: false,
    advance: false,
  },
  coordinate: {
    observe: true,
    verify: true,
    "review-edits": true,
    interact: true,
    advance: true,
  },
};

test("observe is the safe default coordinator mode", () => {
  assert.equal(DEFAULT_COORDINATOR_MODE, "observe");
});

test("coordinator modes expose the expected capability matrix", () => {
  for (const mode of COORDINATOR_MODES) {
    for (const capability of Object.keys(expected[mode]) as CoordinatorCapability[]) {
      assert.equal(
        coordinatorModeAllows(mode, capability),
        expected[mode][capability],
        `${mode} ${capability}`,
      );
    }
  }
});

test("coordinator modes validate persisted and API values", () => {
  assert.equal(isCoordinatorMode("observe"), true);
  assert.equal(isCoordinatorMode("verify"), true);
  assert.equal(isCoordinatorMode("coordinate"), true);
  assert.equal(isCoordinatorMode("active"), false);
  assert.equal(isCoordinatorMode(null), false);
});

test("coordinator mode escalation follows capability order", () => {
  assert.equal(isCoordinatorModeEscalation("observe", "verify"), true);
  assert.equal(isCoordinatorModeEscalation("verify", "coordinate"), true);
  assert.equal(isCoordinatorModeEscalation("coordinate", "observe"), false);
  assert.equal(isCoordinatorModeEscalation("verify", "verify"), false);
});
