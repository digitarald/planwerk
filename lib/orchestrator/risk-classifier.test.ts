import assert from "node:assert/strict";
import { test } from "node:test";

import { classifyRiskDeterministically, requiresConservativeHighRisk } from "./risk-classifier.ts";

test("incomplete counts-only facts fail closed as high risk", () => {
  assert.deepEqual(
    classifyRiskDeterministically({
      title: "Tiny change",
      filesChanged: 1,
      additions: 1,
      deletions: 0,
      factsComplete: false,
    }),
    {
      level: "high",
      factors: ["Authoritative file facts are incomplete"],
    },
  );
});

test("tiny auth and schema changes remain high risk during SDK fallback", () => {
  for (const filePath of [
    "src/auth/session.ts",
    "db/migrations/001-add-user.sql",
    "lib/db/schema.ts",
    "src/permissions/roles.ts",
  ]) {
    const assessment = classifyRiskDeterministically({
      title: "Tiny fix",
      filesChanged: 1,
      additions: 2,
      deletions: 1,
      filePaths: [filePath],
      factsComplete: true,
    });
    assert.equal(assessment.level, "high", filePath);
  }
});

test("complete benign facts may use low-risk fallback policy", () => {
  assert.deepEqual(
    classifyRiskDeterministically({
      title: "Fix README typo",
      filesChanged: 1,
      additions: 1,
      deletions: 1,
      filePaths: ["README.md"],
      factsComplete: true,
    }),
    {
      level: "low",
      factors: ["Small change with complete file facts"],
    },
  );
});

test("scope is a model signal rather than a mandatory high-risk floor", () => {
  const input = {
    title: "Large reversible update",
    filesChanged: 30,
    additions: 2_000,
    deletions: 500,
    filePaths: ["src/render.ts"],
    factsComplete: true,
  };
  assert.equal(requiresConservativeHighRisk(input), null);
  assert.equal(classifyRiskDeterministically(input).level, "high", "SDK failure remains conservative");
});

test("prose is contextual evidence, not a keyword-based mandatory verdict", () => {
  const input = {
    title: "Explain authentication and schema design",
    activity: "Document security and permissions",
    planContent: "Describe rollback; do not delete database records.",
    lastAgentMessage: "No credentials or production systems changed.",
    filesChanged: 1,
    additions: 10,
    deletions: 1,
    filePaths: ["notes/design.md"],
    factsComplete: true,
  };
  assert.equal(requiresConservativeHighRisk(input), null);
  assert.equal(classifyRiskDeterministically(input).level, "high", "SDK failure preserves conservative keyword fallback");
  assert.equal(requiresConservativeHighRisk({
    ...input, filePaths: ["src/auth/session.ts"],
  })?.level, "high");
});
