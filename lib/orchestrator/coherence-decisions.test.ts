import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { after, beforeEach, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { decisionChoice, type DecisionOutcome, type DecisionQuestions } from "../decisions/core.ts";
import type { CardOverlapContent } from "./coherence-content.ts";
import type { CoherenceRow } from "./coherence-engine.ts";

const HOST = "ws://coherence-decision.test";
const A = "copilotcli:/a";
const B = "copilotcli:/b";
const FILE = "/repo/shared.ts";
const row: CoherenceRow = {
  id: 1, cardA: A, cardB: B, tier: "file", overlapPaths: [FILE],
  signature: JSON.stringify(["coherence-v2", "file", [FILE], [A, "source-a"], [B, "source-b"]]),
  status: "detected", updatedAt: "2026-11-05", hostUrl: HOST,
};

function outcome(choice: string, kind: DecisionOutcome["kind"] = "accepted"): DecisionOutcome {
  return {
    kind, key: "decision-1", policyKey: "policy-1", latencyMs: 1,
    ...(kind === "deferred" ? {} : {
      response: {
        model: "test-decision",
        answers: { classification: { type: "choice", choice, probabilities: { [choice]: 1 } } },
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    }),
  };
}

const state = {
  mode: "active",
  policyKey: "policy-1",
  current: true,
  claim: true,
  apply: true,
  decision: outcome("coherent"),
  onDecision: undefined as (() => void) | undefined,
  decisionError: undefined as Error | undefined,
  content: new Map<string, CardOverlapContent>(),
  calls: [] as string[],
  decisions: [] as unknown[][],
  shadows: [] as unknown[][],
  completions: [] as unknown[][],
  deferrals: [] as unknown[][],
  legacy: { status: "conflict", summary: "Legacy clash.", findings: ["Existing legacy finding."] },
};
const key = "__planwerkCoherenceDecisions";
Object.defineProperty(globalThis, key, { value: { state, decisionChoice }, configurable: true });
const root = path.resolve(import.meta.dirname, "../..");
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    const bridge = `const s=globalThis["${key}"].state;`;
    let source: string | undefined;
    if (specifier === "server-only") source = "export {}";
    if (specifier === "../decisions/service.ts") source = `${bridge}
      export function decisionProfile() { return {mode:s.mode}; }
      export function decisionStillCurrent(_family,_version,outcome) {
        return s.mode==="active" && outcome.policyKey===s.policyKey;
      }
      export const decisionChoice=globalThis["${key}"].decisionChoice;
      export async function decide(...args) {
        s.decisions.push(args); s.onDecision?.();
        if(s.decisionError) throw s.decisionError;
        return s.decision;
      }
      export function scheduleShadow(...args) { s.shadows.push(args); }`;
    if (specifier === "./coherence-content") source = `${bridge}
      export async function fetchOverlapContent(_host,id) { return s.content.get(id); }`;
    if (specifier === "./coherence-engine") source = `${bridge}
      export function claimForReviewOwner(...args) { s.calls.push("claim"); return s.claim; }
      export function isCoherenceReviewCurrent() { return s.current; }
      export function renewCoherenceReviewLease() {}
      export function completeReview(...args) { s.completions.push(args); return s.apply; }
      export function deferCoherenceReview(...args) { s.deferrals.push(args); return true; }`;
    if (specifier === "./risk-store") source = 'export function getRiskForAutomation() { return "medium"; }';
    if (specifier === "./model") source = 'export async function selectOrchestratorModel() { return {model:"legacy-model"}; }';
    if (specifier === "./copilot-session") source = `${bridge}
      export async function disposeOneShotSession() { return {failures:[]}; }
      export async function invalidateRuntimeForCleanupFailure() {}
      export async function releaseRuntimeLease() {}`;
    if (specifier === "./sdk-runtime") source = `${bridge}
      export async function acquireCopilotRuntimeClient() {
        s.calls.push("sdk");
        return {client:{async createSession() {
          return {async sendAndWait(_message,schema) { return schema.parse(s.legacy); }};
        }}};
      }
      export function classifyCopilotFailure() { return "domain"; }`;
    if (specifier === "@/lib/db/work-lease-schema") source = "export const WORK_LEASE_MS=30000;";
    if (source) return { shortCircuit: true, url: `data:text/javascript,${encodeURIComponent(source)}` };
    if (specifier.startsWith("@/")) {
      return { shortCircuit: true, url: pathToFileURL(path.join(root, `${specifier.slice(2)}.ts`)).href };
    }
    if (specifier.startsWith(".") && !path.extname(specifier) && context.parentURL?.startsWith("file:")) {
      const candidate = fileURLToPath(new URL(`${specifier}.ts`, context.parentURL));
      if (existsSync(candidate)) return { shortCircuit: true, url: pathToFileURL(candidate).href };
    }
    return nextResolve(specifier, context);
  },
});
const { runCoherenceExecutor } = await import("./coherence-reviewer.ts");

after(() => {
  hooks.deregister();
  Reflect.deleteProperty(globalThis, key);
});
beforeEach(() => {
  Object.assign(state, {
    mode: "active", policyKey: "policy-1", current: true, claim: true, apply: true,
    decision: outcome("coherent"), onDecision: undefined, decisionError: undefined,
  });
  for (const list of [state.calls, state.decisions, state.shadows, state.completions, state.deferrals]) list.length = 0;
  for (const id of [A, B]) state.content.set(id, {
    sessionUri: id, status: "ready", failed: false,
    files: [{ path: FILE, content: id === A ? "export const a = 1;" : "export const b = 2;", truncated: false }],
  });
});

test("active coherence classifies complete two-sided source-bound evidence without SDK findings", async () => {
  for (const classification of ["coherent", "conflict"] as const) {
    state.decision = outcome(classification);
    const result = await runCoherenceExecutor(HOST, [row], new Map());
    assert.equal(result[0].status, classification);
    assert.match(result[0].summary, /copilotcli:\/a @ source-a/);
    assert.match(result[0].summary, /copilotcli:\/b @ source-b/);
    const [family, version, input, questions, options] = state.decisions.at(-1)! as [
      string, string, { signature: string; a: CardOverlapContent & { sourceRevision: string }; b: CardOverlapContent & { sourceRevision: string } },
      DecisionQuestions, { hostUrl: string; owner: string },
    ];
    assert.equal(family, "coherence");
    assert.equal(version, "coherence-semantic-v1");
    assert.equal(input.signature, row.signature);
    assert.equal(input.a.sourceRevision, "source-a");
    assert.equal(input.b.sourceRevision, "source-b");
    assert.equal(input.a.files[0].content, "export const a = 1;");
    assert.equal(input.b.files[0].content, "export const b = 2;");
    assert.deepEqual(Object.keys((questions.classification as { criteria: object }).criteria), ["coherent", "conflict", "insufficient"]);
    assert.deepEqual(options, { hostUrl: HOST, owner: "coherence:1", signal: undefined });
    const completion = state.completions.at(-1)!;
    assert.equal(completion[1], row.signature);
    assert.equal(typeof completion[3], "string");
    assert.deepEqual((completion[2] as { findings: string[] }).findings, []);
  }
  assert.equal(state.calls.includes("sdk"), false);
});

test("semantic abstention, unknown output and infrastructure defer without SDK fallback", async () => {
  for (const [decision, reason] of [
    [outcome("insufficient"), "evidence-unavailable"],
    [outcome("insufficient", "needs-human"), "evidence-unavailable"],
    [outcome("unknown"), "invalid-model-output"],
    [outcome("coherent", "deferred"), "infrastructure"],
  ] as const) {
    state.decision = decision;
    assert.deepEqual(await runCoherenceExecutor(HOST, [row], new Map()), []);
    assert.equal(state.deferrals.at(-1)?.[3], reason);
  }
  state.decisionError = new Error("offline");
  assert.deepEqual(await runCoherenceExecutor(HOST, [row], new Map()), []);
  assert.equal(state.deferrals.at(-1)?.[3], "infrastructure");
  assert.equal(state.completions.length, 0);
  assert.equal(state.calls.includes("sdk"), false);
});

test("active coherence refuses partial, truncated or unbound evidence before judging", async () => {
  const ready = state.content.get(B)!;
  const cases: Array<[CardOverlapContent, string]> = [
    [{ ...ready, files: [{ ...ready.files[0], truncated: true }] }, "evidence-limit"],
    [{ ...ready, sessionUri: A }, "source-changed"],
    [{ ...ready, status: "deferred", failed: true, reason: "read-unavailable", files: [] }, "evidence-unavailable"],
  ];
  for (const [content, reason] of cases) {
    state.content.set(B, content);
    assert.deepEqual(await runCoherenceExecutor(HOST, [row], new Map()), []);
    assert.equal(state.deferrals.at(-1)?.[3], reason);
  }
  state.content.set(B, ready);
  assert.deepEqual(await runCoherenceExecutor(HOST, [{ ...row, signature: "legacy" }], new Map()), []);
  assert.equal(state.decisions.length, 0);
  assert.equal(state.completions.length, 0);
});

test("active coherence preserves source, policy and lease/CAS fences through decision awaits", async () => {
  for (const change of [
    () => { state.current = false; },
    () => { state.policyKey = "policy-2"; },
    () => { state.mode = "legacy"; },
  ]) {
    Object.assign(state, { current: true, policyKey: "policy-1", mode: "active", onDecision: change });
    assert.deepEqual(await runCoherenceExecutor(HOST, [row], new Map()), []);
  }
  assert.equal(state.completions.length, 0);
  Object.assign(state, { current: true, policyKey: "policy-1", mode: "active", onDecision: undefined, apply: false });
  assert.deepEqual(await runCoherenceExecutor(HOST, [row], new Map()), []);
  assert.equal(state.deferrals.at(-1)?.[3], "source-changed");
  state.claim = false;
  const count = state.decisions.length;
  assert.deepEqual(await runCoherenceExecutor(HOST, [row], new Map()), []);
  assert.equal(state.decisions.length, count);
});

test("legacy stays authoritative and shadow only records a bounded non-authoritative classification", async () => {
  for (const mode of ["legacy", "shadow"]) {
    state.mode = mode;
    const result = await runCoherenceExecutor(HOST, [row], new Map());
    assert.equal(result[0].status, "conflict");
    assert.equal(result[0].summary, "Legacy clash.");
    assert.equal(state.decisions.length, 0);
    assert.equal(state.shadows.length, mode === "shadow" ? 1 : 0);
  }
  assert.equal(state.calls.filter((call) => call === "sdk").length, 2);
});
