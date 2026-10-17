import assert from "node:assert/strict";
import test from "node:test";
import type { ResponseSchema } from "@github/copilot-sdk";

import {
  coherenceVerdictSchema,
  judgeVerdictSchema,
  riskAssessmentSchema,
} from "./response-schemas.ts";

test("response schemas implement the SDK typed-result contract", () => {
  const schemas: ResponseSchema[] = [
    riskAssessmentSchema,
    judgeVerdictSchema,
    coherenceVerdictSchema,
  ];
  for (const schema of schemas) {
    const json = schema.toJSONSchema();
    assert.equal(json.type, "object");
    assert.equal(json.additionalProperties, false);
    assert.ok(Array.isArray(json.required));
    assert.ok(json.required.length > 0);
  }
});

test("risk outputs reject unknown levels, coercion, and empty evidence", () => {
  assert.deepEqual(
    riskAssessmentSchema.parse({ level: "medium", factors: [" Dependency update. "] }),
    { level: "medium", factors: ["Dependency update."] },
  );
  for (const value of [
    undefined,
    { level: "safe", factors: ["Looks fine"] },
    { level: "low", factors: [] },
    { level: "low", factors: [42] },
    { level: "low", factors: [" "] },
    { level: "low", factors: ["Small change"], unexpected: true },
  ]) {
    assert.equal(riskAssessmentSchema.safeParse(value).success, false);
  }
});

test("coherence results cannot approve conflicts or invent unsupported verdicts", () => {
  assert.deepEqual(
    coherenceVerdictSchema.parse({
      status: "coherent", summary: " Independent edits. ", findings: [],
    }),
    { status: "coherent", summary: "Independent edits.", findings: [] },
  );
  for (const value of [
    { status: "coherent", summary: "Looks fine", findings: ["Collision"] },
    { status: "conflict", summary: "A clash", findings: [] },
    { status: "conflict", summary: "", findings: ["Collision"] },
    { status: "conflict", summary: "A clash", findings: [false] },
    { status: "passed", summary: "Looks fine", findings: [] },
  ]) {
    assert.equal(coherenceVerdictSchema.safeParse(value).success, false);
  }
  assert.equal(coherenceVerdictSchema.safeParse({
    status: "needs-human", summary: "Evidence missing.", findings: [],
  }).success, true);
});
