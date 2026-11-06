import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { after, beforeEach, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { decisionChoice, validateQuestions } from "../decisions/core.ts";
import type { DecisionOutcome, DecisionQuestions } from "../decisions/core.ts";

interface Request {
  family: "review" | "goal";
  version: string;
  state: Record<string, unknown>;
  questions: DecisionQuestions;
  options: { hostUrl?: string; owner?: string; signal?: AbortSignal };
}
const runtime = {
  modes: { review: "active", goal: "active" } as Record<string, "legacy" | "shadow" | "active">,
  policy: "policy-1",
  requests: [] as Request[],
  shadows: [] as Request[],
  sdkCalls: 0,
  sdkResult: undefined as unknown,
  sdkMessages: [] as { prompt: string; source: string }[],
  sdkPrompts: [] as string[],
  async answer(request: Request): Promise<DecisionOutcome> { return accepted(request); },
  decisionChoice,
};
function accepted(request: Request, choices: Record<string, string> = {}): DecisionOutcome {
  return {
    kind: "accepted", key: "test-key", policyKey: `${runtime.policy}:${request.version}`, latencyMs: 1,
    response: {
      model: "test-decision", usage: { input_tokens: 0, output_tokens: 0 },
      answers: Object.fromEntries(Object.entries(request.questions).map(([name, question]) => {
        assert.equal(question.type, "choice");
        const choice = choices[name] ?? (name === "substantive_evidence" ? "complete"
          : name === "unresolved_blockers" ? "none" : "satisfied");
        return [name, {
          type: "choice", choice, confidence: 1,
          probabilities: Object.fromEntries(Object.keys(question.type === "choice" ? question.criteria : {}).map((label) => [label, label === choice ? 1 : 0])),
        }];
      })),
    },
  };
}
const globalKey = "__reviewGoalDecisionTest";
Object.defineProperty(globalThis, globalKey, { value: runtime, configurable: true });
const prelude = `const s=globalThis["${globalKey}"];`;
const hooks = registerHooks({
  resolve(specifier, context, next) {
    let source: string | undefined;
    if (specifier === "server-only") source = "";
    if (specifier === "../decisions/service.ts") source = `
      export const decisionProfile=(family)=>({mode:s.modes[family]});
      export const decisionChoice=s.decisionChoice;
      export const decisionStillCurrent=(family,version,outcome)=>s.modes[family]==="active"&&outcome.policyKey===s.policy+":"+version;
      export async function decide(family,version,state,questions,options) {
        const request={family,version,state,questions,options};s.requests.push(request);
        return s.answer(request);
      }
      export function scheduleShadow(family,version,state,questions,options) {
        s.shadows.push({family,version,state,questions,options});
      }`;
    if (specifier === "./sdk-runtime") source = `
      export async function acquireCopilotRuntimeClient() {
        s.sdkCalls++;
        return {client:{
          async createSession(options) {
            s.sdkPrompts.push(options.systemMessage.content);
            return {sessionId:"test-session",async sendAndWait(message,schema) {
              s.sdkMessages.push(message);return schema.parse(s.sdkResult);
            },async abort(){},async disconnect(){}};
          },async deleteSession(){}
        },async release(){},async invalidate(){return true}};
      }
      export function classifyCopilotFailure(){return "domain"}`;
    if (specifier === "./model") source = 'export async function selectOrchestratorModel(){return {model:"test-sdk"}}';
    if (source !== undefined) return { shortCircuit: true, url: `data:text/javascript,${encodeURIComponent(prelude + source)}` };
    if (specifier.startsWith(".") && !path.extname(specifier) && context.parentURL?.startsWith("file:")) {
      const candidate = fileURLToPath(new URL(`${specifier}.ts`, context.parentURL));
      if (existsSync(candidate)) return { shortCircuit: true, url: pathToFileURL(candidate).href };
    }
    return next(specifier, context);
  },
});
after(() => {
  hooks.deregister();
  Reflect.deleteProperty(globalThis, globalKey);
});
beforeEach(() => {
  runtime.modes.review = runtime.modes.goal = "active";
  runtime.policy = "policy-1";
  runtime.requests.length = runtime.shadows.length = runtime.sdkMessages.length = runtime.sdkPrompts.length = 0;
  runtime.sdkCalls = 0;
  runtime.sdkResult = undefined;
  runtime.answer = async (request) => accepted(request);
});

const { judgeReviewResponse } = await import("./verdict-judge.ts");
const { judgeCoordinatorGoal } = await import("./coordinator-goal-decision.ts");
const signal = new AbortController().signal;
const options = { hostUrl: "local://test", owner: "goal:test" };
function goalEvidence(count = 1) {
  return {
    objective: "Integrate the verified reports",
    acceptanceCriteria: "The integrated report covers every work item",
    candidates: Array.from({ length: count }, (_, index) => ({
      itemId: `item-${index}`, cardId: `worker-${index}`, state: "awaiting-result",
      acceptanceCriteria: "Report contains the measured result and its source",
      result: `Measured result ${index}: 42. Source: recorded verification report.`,
      digest: `digest-${index}`, runtime: "idle", gatesVerified: true,
    })),
    priorResults: [] as { id: string; criteria: string; outcome: string; evidence: { digest: string; accepted: boolean; verified: boolean } }[],
  };
}

test("legacy review and goal retain SDK output shapes and do not infer decisions", async () => {
  runtime.modes.review = runtime.modes.goal = "legacy";
  runtime.sdkResult = { status: "passed", summary: "Independent SDK judgment", findings: [] };
  assert.deepEqual(await judgeReviewResponse("Original review"), runtime.sdkResult);
  runtime.sdkResult = { acceptedItemIds: ["legacy-id"], goalCompleted: true, needsHuman: false, summary: "Legacy result" };
  assert.deepEqual(await judgeCoordinatorGoal({ objective: "Legacy input" }, signal), runtime.sdkResult);
  assert.equal(runtime.sdkCalls, 2);
  assert.equal(runtime.requests.length, 0);
  assert.equal(runtime.shadows.length, 0);
  assert.ok(runtime.sdkMessages.every((message) => message.source === "system"));
});

test("shadow records bounded decisions but returns only legacy judgments", async () => {
  runtime.modes.review = runtime.modes.goal = "shadow";
  runtime.sdkResult = { status: "failed", summary: "SDK found a blocker", findings: ["Original blocker"] };
  assert.deepEqual(await judgeReviewResponse("Substantive review"), runtime.sdkResult);
  runtime.sdkResult = { acceptedItemIds: ["item-0"], goalCompleted: false, needsHuman: false, summary: "Legacy goal" };
  assert.deepEqual(await judgeCoordinatorGoal(goalEvidence(), signal, options), runtime.sdkResult);
  assert.equal(runtime.sdkCalls, 2);
  assert.equal(runtime.requests.length, 0);
  assert.deepEqual(runtime.shadows.map((request) => request.family), ["review", "goal", "goal"]);
  for (const request of runtime.shadows) validateQuestions(request.questions);
});

test("active review uses fixed evidence questions and retains original failed-review evidence", async () => {
  const source = "Reviewed all changed paths. The authorization test still fails because the endpoint accepts anonymous writes.";
  runtime.answer = async (request) => accepted(request, { unresolved_blockers: "present" });
  const result = await judgeReviewResponse(source);
  assert.equal(result.status, "failed");
  assert.deepEqual(result.findings, [source]);
  assert.ok(result.decisionBinding);
  assert.deepEqual(Object.keys(runtime.requests[0].questions), ["substantive_evidence", "unresolved_blockers"]);
  assert.equal(runtime.requests[0].state.reviewResponse, source);
  validateQuestions(runtime.requests[0].questions);
  assert.equal(runtime.sdkCalls, 0);
});

test("active plan review retains complete-plan report-only requirements and revision", async () => {
  const result = await judgeReviewResponse("Assessed every section of the complete parent plan; no blockers remain.", "plan:parent:hash");
  assert.equal(result.status, "passed");
  const request = runtime.requests[0];
  assert.equal(request.state.reviewKind, "complete-plan-report-only");
  assert.equal(request.state.reviewedRevision, "plan:parent:hash");
  assert.match(request.questions.substantive_evidence.instructions, /complete parent plan/);
  assert.match(request.questions.substantive_evidence.instructions, /reviewer edits/);
  assert.equal(runtime.sdkCalls, 0);
});

test("review abstentions, partial responses, unknowns, contradictions and failures never fall back to SDK", async () => {
  const answers: ((request: Request) => Promise<DecisionOutcome>)[] = [
    async (request) => ({ ...accepted(request), kind: "needs-human" }),
    async (request) => ({ ...accepted(request), kind: "deferred" }),
    async (request) => ({ ...accepted(request), response: undefined }),
    async (request) => {
      const outcome = accepted(request);
      delete outcome.response!.answers.unresolved_blockers;
      return outcome;
    },
    async (request) => accepted(request, { substantive_evidence: "insufficient", unresolved_blockers: "none" }),
    async (request) => accepted(request, { unresolved_blockers: "insufficient" }),
    async (request) => accepted(request, { substantive_evidence: "unknown" }),
    async () => { throw new Error("offline"); },
  ];
  for (const answer of answers) {
    runtime.answer = answer;
    const result = await judgeReviewResponse("A partial or ambiguous source review");
    assert.equal(result.status, "needs-human");
    assert.deepEqual(result.findings, []);
  }
  assert.equal(runtime.sdkCalls, 0);
});

test("missing and oversized review evidence cannot be truncated into acceptance", async () => {
  for (const source of [undefined, " ", "é".repeat(33_000)]) {
    assert.equal((await judgeReviewResponse(source)).status, "needs-human");
  }
  assert.equal(runtime.requests.length, 0);
  assert.equal(runtime.sdkCalls, 0);
});

test("review acceptance is invalidated when its policy or active mode changes during inference", async () => {
  for (const change of ["policy", "mode"]) {
    runtime.modes.review = "active";
    runtime.answer = async (request) => {
      const outcome = accepted(request);
      if (change === "policy") runtime.policy = "policy-2";
      else runtime.modes.review = "legacy";
      return outcome;
    };
    const result = await judgeReviewResponse("A complete independent source review");
    assert.equal(result.status, "needs-human");
    assert.equal(result.decisionBinding, undefined);
  }
  assert.equal(runtime.sdkCalls, 0);
});

test("goal accepts only locally correlated items with satisfied criteria and preserves partial acceptance", async () => {
  runtime.answer = async (request) => accepted(request, request.state.candidateItemId === "item-1"
    ? { criteria_satisfied: "unmet" } : {});
  const result = await judgeCoordinatorGoal(goalEvidence(2), signal, options);
  assert.deepEqual(result.acceptedItemIds, ["item-0"]);
  assert.equal(result.goalCompleted, false);
  assert.equal(result.needsHuman, true);
  assert.equal(runtime.requests.length, 2);
  assert.ok(runtime.requests.every((request) => request.state.candidateItemId));
  assert.ok(runtime.requests.every((request) => request.options.hostUrl === options.hostUrl && request.options.owner === options.owner && request.options.signal === signal));
  assert.equal(runtime.sdkCalls, 0);
});

test("a goal item abstention cannot accept it or suppress separately accepted items", async () => {
  for (const kind of ["needs-human", "deferred"] as const) {
    runtime.answer = async (request) => request.state.candidateItemId === "item-1" ? { ...accepted(request), kind } : accepted(request);
    const result = await judgeCoordinatorGoal(goalEvidence(2), signal);
    assert.deepEqual(result.acceptedItemIds, ["item-0"]);
    assert.equal(result.goalCompleted, false);
    assert.equal(result.needsHuman, true);
  }
  assert.equal(runtime.requests.length, 4);
  assert.equal(runtime.sdkCalls, 0);
});

test("unknown, contradictory or partial goal-item answers require human inspection", async () => {
  const cases: Record<string, string>[] = [
    { substantive_evidence: "insufficient", criteria_satisfied: "satisfied" },
    { criteria_satisfied: "unknown" },
    { criteria_satisfied: "insufficient" },
  ];
  for (const choices of cases) {
    runtime.answer = async (request) => accepted(request, choices);
    const result = await judgeCoordinatorGoal(goalEvidence(), signal);
    assert.deepEqual(result.acceptedItemIds, []);
    assert.equal(result.needsHuman, true);
  }
  runtime.answer = async (request) => {
    const outcome = accepted(request);
    delete outcome.response!.answers.substantive_evidence;
    return outcome;
  };
  assert.equal((await judgeCoordinatorGoal(goalEvidence(), signal)).needsHuman, true);
  assert.equal(runtime.sdkCalls, 0);
});

test("overall goal requires a dependent independent acceptance, not accepted item IDs or task counts", async () => {
  runtime.answer = async (request) => {
    if (request.state.candidateItemId) return accepted(request);
    assert.deepEqual(request.state.itemJudgments, [{ itemId: "item-0", criteria: "satisfied" }]);
    assert.equal(runtime.requests.length, 2);
    return accepted(request, { goal_satisfied: "unmet" });
  };
  const result = await judgeCoordinatorGoal(goalEvidence(), signal);
  assert.deepEqual(result.acceptedItemIds, ["item-0"]);
  assert.equal(result.goalCompleted, false);
  assert.equal(result.needsHuman, false);
  assert.equal(runtime.sdkCalls, 0);
});

test("overall goal abstention keeps accepted items but cannot complete the goal", async () => {
  for (const overall of ["needs-human", "unknown", "insufficient", "partial", "contradictory"]) {
    runtime.answer = async (request) => {
      const outcome = accepted(request);
      if (request.state.candidateItemId) return outcome;
      if (overall === "needs-human") return { ...outcome, kind: "needs-human" };
      if (overall === "partial") { delete outcome.response!.answers.goal_satisfied; return outcome; }
      return accepted(request, overall === "contradictory"
        ? { substantive_evidence: "insufficient", goal_satisfied: "satisfied" } : { goal_satisfied: overall });
    };
    const result = await judgeCoordinatorGoal(goalEvidence(), signal);
    assert.deepEqual(result.acceptedItemIds, ["item-0"]);
    assert.equal(result.goalCompleted, false);
    assert.equal(result.needsHuman, true);
  }
  assert.equal(runtime.sdkCalls, 0);
});

test("goal success carries item and overall policy bindings and retains full prior evidence", async () => {
  const evidence = goalEvidence();
  evidence.priorResults.push({ id: "prior", criteria: "A measured result", outcome: "Recorded independent verification",
    evidence: { digest: "prior-digest", accepted: true, verified: true } });
  const result = await judgeCoordinatorGoal(evidence, signal);
  assert.equal(result.goalCompleted, true);
  assert.equal(result.needsHuman, false);
  assert.equal(result.decisionBindings?.length, 2);
  assert.deepEqual((runtime.requests[1].state.evidence as typeof evidence).priorResults, evidence.priorResults);
  assert.equal(runtime.sdkCalls, 0);
});

test("unverified gates prevent overall completion without discarding semantic item acceptance", async () => {
  const evidence = goalEvidence();
  evidence.candidates[0].gatesVerified = false;
  const result = await judgeCoordinatorGoal(evidence, signal);
  assert.deepEqual(result.acceptedItemIds, ["item-0"]);
  assert.equal(result.goalCompleted, false);
  assert.equal(result.needsHuman, false);
  assert.equal(runtime.requests.length, 1);
});

test("invalid, duplicate, uncorrelated, truncated, oversized or over-count goal evidence fails closed", async () => {
  const duplicate = goalEvidence(2);
  duplicate.candidates[1].itemId = duplicate.candidates[0].itemId;
  const oversized = goalEvidence();
  oversized.candidates[0].result = "é".repeat(33_000);
  const invalid = [
    {}, goalEvidence(0), goalEvidence(33), duplicate, oversized,
    { ...goalEvidence(), candidates: [{ ...goalEvidence().candidates[0], runtime: "running" }] },
    { ...goalEvidence(), candidates: [{ ...goalEvidence().candidates[0], pendingInput: "request" }] },
    { ...goalEvidence(), candidates: [{ ...goalEvidence().candidates[0], uncorrelated: true }] },
    { ...goalEvidence(), candidates: [{ ...goalEvidence().candidates[0], gateReportsTruncated: true }] },
    { ...goalEvidence(), priorResults: [{ id: "old", criteria: "Done", outcome: "Claim", evidence: { accepted: true, verified: false, digest: "old" } }] },
  ];
  for (const evidence of invalid) {
    const result = await judgeCoordinatorGoal(evidence, signal);
    assert.deepEqual(result.acceptedItemIds, []);
    assert.equal(result.goalCompleted, false);
    assert.equal(result.needsHuman, true);
  }
  assert.equal(runtime.requests.length, 0);
  assert.equal(runtime.sdkCalls, 0);
});

test("the full 32-item bound is assessed without question or evidence truncation", async () => {
  const result = await judgeCoordinatorGoal(goalEvidence(32), signal);
  assert.equal(result.acceptedItemIds.length, 32);
  assert.equal(result.goalCompleted, true);
  assert.equal(runtime.requests.length, 33);
  for (const request of runtime.requests) validateQuestions(request.questions);
  assert.equal(runtime.sdkCalls, 0);
});

test("goal policy or active-mode drift during overall judgment revokes all staged acceptances", async () => {
  for (const change of ["policy", "mode"]) {
    runtime.modes.goal = "active";
    runtime.answer = async (request) => {
      const outcome = accepted(request);
      if (!request.state.candidateItemId) {
        if (change === "policy") runtime.policy += "-changed";
        else runtime.modes.goal = "shadow";
      }
      return outcome;
    };
    const result = await judgeCoordinatorGoal(goalEvidence(), signal);
    assert.deepEqual(result.acceptedItemIds, []);
    assert.equal(result.goalCompleted, false);
    assert.equal(result.needsHuman, true);
  }
  assert.equal(runtime.sdkCalls, 0);
});

test("active cancellation never acquires an SDK session or accepts a late goal judgment", async () => {
  const controller = new AbortController();
  runtime.answer = async (request) => { controller.abort(); return accepted(request); };
  await assert.rejects(() => judgeCoordinatorGoal(goalEvidence(), controller.signal), { name: "AbortError" });
  assert.equal(runtime.sdkCalls, 0);
});
