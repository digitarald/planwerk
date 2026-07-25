import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { parse } from "yaml";

type GateRef =
  | { type: "script"; name: string }
  | { type: "review"; skill: string }
  | { type: "artifact"; artifact: string };

const config = parse(
  readFileSync(new URL("../../.github/planwerk.yml", import.meta.url), "utf8")
) as {
  skills: Record<string, { prompt: string }>;
  gates: Record<string, { required: GateRef[] }>;
};

test("build exit proves implementation readiness", () => {
  const required = config.gates["build-to-review"].required;
  assert.deepEqual(
    required.filter((gate) => gate.type === "script").map((gate) => gate.name),
    ["Lint", "Type Check", "Build", "Test"]
  );
  assert.ok(
    required.some(
      (gate) => gate.type === "review" && gate.skill === "code-review"
    )
  );
});

test("review exit requires the handoff assessment and review artifact", () => {
  const required = config.gates["review-to-ship"].required;
  assert.ok(
    required.some(
      (gate) => gate.type === "review" && gate.skill === "review-report"
    )
  );
  assert.ok(
    required.some(
      (gate) => gate.type === "artifact" && gate.artifact === "review"
    )
  );
  assert.match(config.skills["review-report"].prompt, /plan\.md/);
  assert.match(config.skills["review-report"].prompt, /review\.md/);
  assert.match(config.skills["review-report"].prompt, /divergences/i);
});
