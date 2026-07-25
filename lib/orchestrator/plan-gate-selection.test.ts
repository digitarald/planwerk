import assert from "node:assert/strict";
import test from "node:test";

import { selectPendingReviewSkills } from "./plan-gate-selection.ts";

test("selects renamed and multiple configured review gates without fixed skill IDs", () => {
  const result = selectPendingReviewSkills(
    [
      { gateType: "review", gateName: "product-plan-critic" },
      { gateType: "review", gateName: "architecture-challenger" },
    ],
    [
      { id: "architecture-challenger", prompt: "/architecture-review" },
      { id: "product-plan-critic", prompt: "/rubber-duck" },
      { id: "code-review", prompt: "/review" },
    ],
  );

  assert.deepEqual(
    result.skills.map((skill) => skill.id),
    ["architecture-challenger", "product-plan-critic"],
  );
  assert.deepEqual(result.missingReviewNames, []);
  assert.deepEqual(result.nonReviewNames, []);
});

test("reports missing review skills and pending non-review gates", () => {
  const result = selectPendingReviewSkills(
    [
      { gateType: "review", gateName: "missing-review" },
      { gateType: "artifact", gateName: "plan" },
    ],
    [],
  );

  assert.deepEqual(result.missingReviewNames, ["missing-review"]);
  assert.deepEqual(result.nonReviewNames, ["plan"]);
});
