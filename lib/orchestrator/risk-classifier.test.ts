import assert from "node:assert/strict";
import { test } from "node:test";

import { classifyRiskDeterministically } from "./risk-classifier.ts";

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
