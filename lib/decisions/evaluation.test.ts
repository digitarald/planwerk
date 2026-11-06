import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluateDecisions, evaluationCaseSchema } from "./evaluation.ts";

test("held-out reporting exposes unsafe accepted decisions and abstention rather than agreement with an SDK", () => {
  const rows = [
    { family: "review", question: "verdict", expected: "block", critical: true, outcome: "accepted",
      response: { model: "synthetic", answers: { verdict: { type: "choice", choice: "pass",
        probabilities: { pass: 0.98, block: 0.02 }, confidence: 0.6 } }, usage: { input_tokens: 1000, output_tokens: 1 } },
      latencyMs: 200, baselineLatencyMs: 4000, baselineCostUsd: 0.01 },
    { family: "review", question: "verdict", expected: "block", critical: true,
      outcome: "needs-human", latencyMs: 100 },
  ].map((row) => evaluationCaseSchema.parse(row));
  const metrics = evaluateDecisions(rows).review;
  assert.equal(metrics.criticalErrors, 1);
  assert.equal(metrics.coverage, 0.5);
  assert.equal(metrics.acceptedAccuracy, 0);
  assert.equal(metrics.safetyGate, "not-ready");
  assert.deepEqual(metrics.calibration, [{ probability: 0.98, correct: false, providerConfidence: 0.6 }]);
  assert.equal(metrics.p95Ms, 200);
  assert.equal(metrics.baselineP95Ms, 4000);
});

test("a perfect synthetic replay never authorizes production rollout", () => {
  const row = evaluationCaseSchema.parse({ family: "answer", question: "answer", expected: "true",
    outcome: "accepted", latencyMs: 1, response: { model: "synthetic", answers: { answer: { type: "noul", noul: 0.99 } },
      usage: { input_tokens: 10, output_tokens: 1 } } });
  assert.equal(evaluateDecisions([row]).answer.safetyGate, "requires-human-validation");
});
