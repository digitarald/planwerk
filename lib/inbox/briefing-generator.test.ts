import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { after, beforeEach, test } from "node:test";

import { decisionChoice, type DecisionOutcome, type DecisionQuestions } from "../decisions/core.ts";
import {
  briefingResponseSchema,
  normalizeSynthesizedBriefing,
  type InboxSynthesisEvidence,
} from "./briefing-synthesis-core.ts";

const evidence: InboxSynthesisEvidence = {
  taskTitle: "Documentation updated",
  kind: "completion", eventType: "session-idle", sourceRevision: "source-1",
  currentBriefing: { reason: "The updated guide is ready.", recommendation: "", outcome: "Guide updated.", caveats: [] },
};
const prose = {
  headline: "The guide is ready",
  message: "Review the updated setup guide.",
  primaryActionLabel: "Review guide",
  secondaryActionLabels: [],
};
const legacy = {
  headline: "The guide is ready", message: "No further work remains.", attention: "routine",
  primaryAction: { intent: "resolve", label: "Clear update" }, secondaryActions: [],
};
function outcome(action = "review", kind: DecisionOutcome["kind"] = "accepted"): DecisionOutcome {
  return {
    kind, key: "decision-1", policyKey: "policy-1", latencyMs: 1,
    response: {
      model: "test-decision",
      answers: {
        attention: { type: "choice", choice: "soon", probabilities: { soon: 1 } },
        action: { type: "choice", choice: action, probabilities: { [action]: 1 } },
      },
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  };
}
const state = {
  mode: "active", policyKey: "policy-1",
  outcome: outcome(), response: prose as unknown,
  error: undefined as Error | undefined,
  afterDecision: undefined as (() => void) | undefined,
  afterWrite: undefined as (() => void) | undefined,
  afterRelease: undefined as (() => void) | undefined,
  decisions: [] as unknown[][], shadows: [] as unknown[][],
  calls: [] as string[], prompts: [] as { system: string; prompt?: string; schema?: unknown }[],
};
const key = "__planwerkInboxMetadataDecisions";
Object.defineProperty(globalThis, key, { value: { state, decisionChoice }, configurable: true });
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    const bridge = `const s=globalThis["${key}"].state;`;
    let source: string | undefined;
    if (specifier === "server-only") source = "export {}";
    if (specifier === "../decisions/service.ts") source = `${bridge}
      export function decisionProfile() { return {mode:s.mode}; }
      export function decisionPolicyKey() { return s.policyKey; }
      export function decisionStillCurrent(_family,_version,outcome) {
        return s.mode==="active" && outcome.policyKey===s.policyKey;
      }
      export const decisionChoice=globalThis["${key}"].decisionChoice;
      export async function decide(...args) { s.decisions.push(args); s.afterDecision?.(); return s.outcome; }
      export function scheduleShadow(...args) { s.shadows.push(args); }`;
    if (specifier === "../orchestrator/model.ts") source = 'export async function selectOrchestratorModel() { return {model:"writer-model"}; }';
    if (specifier === "../orchestrator/sdk-runtime.ts") source = `${bridge}
      export async function acquireCopilotRuntimeClient() {
        s.calls.push("acquire");
        return {client:{async createSession(options) {
          s.prompts.push({system:options.systemMessage.content});
          return {async sendAndWait(message,schema) {
            s.calls.push("write");
            Object.assign(s.prompts.at(-1),{prompt:message.prompt,schema:schema.toJSONSchema()});
            s.afterWrite?.();
            if(s.error) throw s.error;
            return schema.parse(s.response);
          }};
        }}};
      }
      export function classifyCopilotFailure() { return "domain"; }`;
    if (specifier === "../orchestrator/copilot-session.ts") source = `${bridge}
      export async function disposeOneShotSession(_client,_session,abort) {
        s.calls.push(abort?"abort-cleanup":"cleanup"); return {failures:[]};
      }
      export async function invalidateRuntimeForCleanupFailure() {}
      export async function releaseRuntimeLease() { s.calls.push("release"); s.afterRelease?.(); }`;
    if (source) return { shortCircuit: true, url: `data:text/javascript,${encodeURIComponent(source)}` };
    return nextResolve(specifier, context);
  },
});
const { generateInboxBriefing } = await import("./briefing-generator.ts");

after(() => {
  hooks.deregister();
  Reflect.deleteProperty(globalThis, key);
});
beforeEach(() => {
  Object.assign(state, {
    mode: "active", policyKey: "policy-1", outcome: outcome(), response: prose,
    error: undefined, afterDecision: undefined, afterWrite: undefined, afterRelease: undefined,
  });
  for (const list of [state.decisions, state.shadows, state.calls, state.prompts]) list.length = 0;
});

test("active inbox fixes accepted attention/action while the writer authors only prose and labels", async () => {
  const result = await generateInboxBriefing(evidence);
  assert.equal(result.briefing.attention, "soon");
  assert.deepEqual(result.briefing.primaryAction, { intent: "review", label: "Review guide" });
  assert.deepEqual(result.briefing.secondaryActions, []);
  assert.deepEqual(result.decision, { policyKey: "policy-1", version: "inbox-metadata-v1" });
  const input = JSON.parse(state.prompts[0].prompt!);
  assert.deepEqual(input.fixedMetadata, { attention: "soon", primaryIntent: "review", secondaryIntents: [] });
  assert.equal(input.evidence.sourceRevision, undefined);
  assert.match(state.prompts[0].system, /Do not select or replace/);
  assert.doesNotMatch(state.prompts[0].system, /Choose the primary intent/);
  const [family, , decisionState, questions] = state.decisions[0] as [
    string, string, { sourceRevision: string }, DecisionQuestions,
  ];
  assert.equal(family, "inbox");
  assert.equal(decisionState.sourceRevision, evidence.sourceRevision);
  assert.deepEqual(Object.keys((questions.action as { criteria: object }).criteria), ["review", "open-session", "resolve", "insufficient"]);
});

test("the prose schema and normalizer cannot grant writer control over accepted metadata", async () => {
  const fixed = { attention: "soon" as const, primaryIntent: "review" as const, secondaryIntents: [] };
  const takeover = { ...prose, ...legacy };
  const schema = briefingResponseSchema("completion", "session-idle", fixed);
  assert.equal(schema.safeParse(takeover).success, false);
  assert.equal(normalizeSynthesizedBriefing(takeover, "completion", "session-idle", fixed)?.attention, "soon");
  assert.equal(normalizeSynthesizedBriefing(takeover, "completion", "session-idle", fixed)?.primaryAction.intent, "review");
  state.response = takeover;
  await assert.rejects(generateInboxBriefing(evidence));
  assert.deepEqual(state.calls, ["acquire", "write", "abort-cleanup", "release"]);
  assert.equal(state.decisions.length, 1);
});

test("uncertain, deferred and disallowed inbox decisions retain the caller's existing failure path without a replacement writer", async () => {
  for (const result of [
    outcome("review", "needs-human"), outcome("review", "deferred"),
    outcome("insufficient"), outcome("approve"),
    { ...outcome(), response: undefined },
  ]) {
    state.outcome = result;
    await assert.rejects(generateInboxBriefing(evidence));
  }
  assert.deepEqual(state.calls, []);
  assert.equal(state.decisions.length, 5);
});

test("ordinary event rules fix WIP and pending-input metadata without extra decisions", async () => {
  state.response = { ...prose, primaryActionLabel: "Inspect build lane", secondaryActionLabels: ["Clear update"] };
  const wip = await generateInboxBriefing({ ...evidence, kind: "review-escalation", eventType: "wip-violation" });
  assert.equal(wip.briefing.attention, "now");
  assert.equal(wip.briefing.primaryAction.intent, "inspect");
  assert.equal(wip.briefing.secondaryActions[0].intent, "resolve");
  state.response = { ...prose, primaryActionLabel: "Finish sign-in" };
  const auth = await generateInboxBriefing({
    ...evidence, kind: "pending-input", eventType: "pending-input",
    session: { pendingInput: { kind: "toolAuthentication" } },
  });
  assert.equal(auth.briefing.primaryAction.intent, "open-session");
  assert.equal(state.decisions.length, 0);
  assert.equal(state.shadows.length, 0);
});

test("policy and mode changes during decision, writer or cleanup awaits reject late inbox results", async () => {
  for (const [stage, change] of [
    ["afterDecision", () => { state.policyKey = "policy-2"; }],
    ["afterWrite", () => { state.policyKey = "policy-2"; }],
    ["afterRelease", () => { state.mode = "legacy"; }],
  ] as const) {
    Object.assign(state, { mode: "active", policyKey: "policy-1", afterDecision: undefined, afterWrite: undefined, afterRelease: undefined });
    state[stage] = change;
    await assert.rejects(generateInboxBriefing(evidence), /policy|current/);
  }
});

test("legacy metadata stays unchanged and shadow evaluates without taking authority from the writer", async () => {
  state.response = legacy;
  for (const mode of ["legacy", "shadow"]) {
    state.mode = mode;
    const result = await generateInboxBriefing(evidence);
    assert.deepEqual(result.briefing, legacy);
    assert.equal(Object.hasOwn(result, "decision"), false);
    assert.equal(state.decisions.length, 0);
    assert.equal(state.shadows.length, mode === "shadow" ? 1 : 0);
    assert.equal(JSON.parse(state.prompts.at(-1)!.prompt!).fixedMetadata, undefined);
  }
  state.error = new Error("writer unavailable");
  await assert.rejects(generateInboxBriefing(evidence), /writer unavailable/);
  assert.equal(state.calls.at(-2), "abort-cleanup");
});
