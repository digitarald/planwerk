import assert from "node:assert/strict";
import { test } from "node:test";
import { acceptanceReason, decisionChoice, validateQuestions, validateResponse, type DecisionQuestions } from "./core.ts";

const questions: DecisionQuestions = {
  verdict: { type: "choice", instructions: "Is current evidence acceptable?", criteria: { pass: "Complete", block: "Unresolved blocker", insufficient: "Missing evidence" } },
};
const policy = { minimumProbability: 0.95, minimumMargin: 0.8, minimumConfidence: 0.9, validationId: "synthetic-tests-only" };
function response(choice = "pass", confidence = 0.99) {
  return { model: "test-model", answers: { verdict: { type: "choice", choice, confidence,
    probabilities: { pass: 0.98, block: 0.01, insufficient: 0.01 } } }, usage: { input_tokens: 10, output_tokens: 1 } };
}

test("selected-label probability and provider confidence are independently enforced", () => {
  assert.equal(acceptanceReason(validateResponse(response(), questions), policy), undefined);
  assert.match(acceptanceReason(validateResponse(response("pass", 0.5), questions), policy)!, /confidence/);
  const lowProbability = response();
  lowProbability.answers.verdict.probabilities = { pass: 0.8, block: 0.19, insufficient: 0.01 };
  assert.match(acceptanceReason(validateResponse(lowProbability, questions), policy)!, /probability/);
  assert.match(acceptanceReason(validateResponse(response(), questions))!, /validated/);
});

test("missing confidence, high-confidence abstention and inconsistent selected labels are never accepted", () => {
  const missing = response();
  Reflect.deleteProperty(missing.answers.verdict, "confidence");
  assert.match(acceptanceReason(validateResponse(missing, questions), policy)!, /confidence/);
  assert.match(acceptanceReason(validateResponse(response("insufficient"), questions), policy)!, /inspection/);
  assert.match(acceptanceReason(validateResponse(response("block"), questions), policy)!, /probability/);
});

test("wire validation rejects missing answers, wrong labels, nonfinite or unnormalized distributions", () => {
  assert.throws(() => validateResponse({ ...response(), answers: {} }, questions), /missing/);
  assert.throws(() => validateResponse(response("invented"), questions), /unknown/);
  for (const value of [NaN, Infinity, -0.1, 2]) {
    const invalid = response();
    invalid.answers.verdict.probabilities.pass = value;
    assert.throws(() => validateResponse(invalid, questions));
  }
  const invalid = response();
  invalid.answers.verdict.probabilities.block = 0.8;
  assert.throws(() => validateResponse(invalid, questions), /distribution/);
});

test("boolean false remains a measured answer, not the result of a failed call", () => {
  const parsed = validateResponse({ model: "test", answers: { safe: { type: "noul", noul: 0.01 } },
    usage: { input_tokens: 1, output_tokens: 1 } }, { safe: { type: "noul", instructions: "Safe?" } });
  assert.equal(acceptanceReason(parsed, policy), undefined);
  assert.equal(parsed.answers.safe.type === "noul" && parsed.answers.safe.noul, 0.01);
  assert.throws(() => decisionChoice({ kind: "needs-human", key: "key", policyKey: "policy", latencyMs: 1 }, "safe", ["yes"]), /accepted/);
});

test("question budgets and bounded choices are validated before inference", () => {
  assert.throws(() => validateQuestions({}), /1 to 32/);
  assert.throws(() => validateQuestions(Object.fromEntries(Array.from({ length: 33 }, (_, index) =>
    [String(index), { type: "noul", instructions: "Enough evidence?" }]))), /1 to 32/);
  assert.throws(() => validateQuestions({ one: { type: "choice", instructions: "Select", criteria: { only: "One" } } }), /2 to 255/);
  assert.throws(() => validateResponse({ model: "test", answers: { rank: { type: "score", score: 2,
    probabilities: { "0": 0.5, "1": 0.5 } } }, usage: { input_tokens: 1, output_tokens: 1 } },
  { rank: { type: "score", instructions: "Rank", criteria: ["Low", "High"] } }), /scale/);
});
