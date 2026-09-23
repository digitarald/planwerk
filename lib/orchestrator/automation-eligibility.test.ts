import assert from "node:assert/strict";
import test from "node:test";

import { isCardAutomationEligible } from "./automation-eligibility.ts";

test("automation eligibility excludes completed and inactive cards", () => {
  assert.equal(
    isCardAutomationEligible({
      isArchived: false,
      phase: "ship",
      runtime: "idle",
    }),
    false,
  );
  assert.equal(
    isCardAutomationEligible({
      isArchived: true,
      phase: "build",
      runtime: "idle",
    }),
    false,
  );
  assert.equal(
    isCardAutomationEligible({
      isArchived: false,
      phase: "define",
      runtime: "idle",
    }),
    false,
  );
  assert.equal(
    isCardAutomationEligible({
      isArchived: false,
      phase: "build",
      runtime: "error",
    }),
    false,
  );
});

test("automation eligibility includes active phases and pending define input", () => {
  assert.equal(
    isCardAutomationEligible({
      isArchived: false,
      phase: "build",
      runtime: "idle",
    }),
    true,
  );
  assert.equal(
    isCardAutomationEligible({
      isArchived: false,
      phase: "define",
      runtime: "input-needed",
    }),
    true,
  );
});
