import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { MessageOptions, ResponseSchema } from "@github/copilot-sdk";
import type { KanbanCard } from "../types.ts";

const state: {
  result: unknown;
  error?: Error;
  calls: string[];
  messages: MessageOptions[];
  timeouts: number[];
} = { result: undefined, calls: [], messages: [], timeouts: [] };

const session = {
  sessionId: "structured-test",
  async sendAndWait(
    message: MessageOptions,
    schemaOrTimeout: ResponseSchema | number,
    timeout?: number,
  ): Promise<unknown> {
    state.messages.push(message);
    const effectiveTimeout = typeof schemaOrTimeout === "number" ? schemaOrTimeout : timeout;
    assert.ok(typeof effectiveTimeout === "number");
    state.timeouts.push(effectiveTimeout);
    if (state.error) throw state.error;
    if (typeof schemaOrTimeout === "number") {
      return { data: { content: state.result } };
    }
    assert.equal(schemaOrTimeout.toJSONSchema().type, "object");
    return schemaOrTimeout.parse(state.result);
  },
  async abort() { state.calls.push("abort"); },
  async disconnect() { state.calls.push("disconnect"); },
};
const client = {
  async createSession() { return session; },
  async deleteSession() { state.calls.push("delete"); },
};
const runtime = {
  client,
  async release() { state.calls.push("release"); },
  async invalidate() { state.calls.push("invalidate"); return true; },
};

const globalKey = "__planwerkStructuredCallerTestRuntime";
Object.defineProperty(globalThis, globalKey, { value: runtime, configurable: true });
const root = path.resolve(import.meta.dirname, "../..");
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    let source: string | undefined;
    if (specifier === "server-only") source = "export {}";
    if (specifier === "./sdk-runtime" || specifier === "../orchestrator/sdk-runtime.ts") {
      source = `export async function acquireCopilotRuntimeClient() {
        return globalThis["${globalKey}"];
      }
      export function classifyCopilotFailure() { return "domain"; }`;
    }
    if (specifier === "./model" || specifier === "../orchestrator/model.ts") {
      source = 'export async function selectOrchestratorModel() { return {model:"test-model"}; }';
    }
    if (specifier === "./risk-store") {
      source = `export function getRiskForAutomation() { return "medium"; }
        export function getAuthoritativeRiskSnapshot() {
          return {elicitationDigest:"elicitation-1",digest:"facts-1"};
        }
        export function getAuthoritativeCardRisk() {
          return {status:"current",currentDigest:"facts-1"};
        }`;
    }
    if (specifier === "./risk-authority") {
      source = 'export function riskAutomationPolicy() { return {current:true,level:"low"}; }';
    }
    if (specifier === "./risk-facts") {
      source = `export function authorizePendingElicitation() {
        return {allowed:true,digest:"elicitation-1"};
      }`;
    }
    if (specifier === "./skill-config") {
      source = "export function canAutoAnswer() { return true; }";
    }
    const unusedAhpFunctions: Record<string, string> = {
      "@/lib/ahp/client-operation": "withAHPClient",
      "@/lib/ahp/map-session": "mapSessionInputNeeded",
      "@/lib/ahp/session-messenger": "answerInputWithClient",
      "@/lib/ahp/snapshot": "readActiveSessionState",
      "@/lib/ahp/answer-value": "buildAnswer",
    };
    if (unusedAhpFunctions[specifier]) {
      source = `export function ${unusedAhpFunctions[specifier]}() {
        throw new Error("Unexpected AHP operation in SDK caller test");
      }`;
    }
    if (specifier === "./coherence-engine") {
      source = `export function claimForReviewOwner() { return true; }
        export function completeReview() { return true; }
        export function isCoherenceReviewCurrent() { return true; }
        export function deferCoherenceReview() { return true; }
        export function renewCoherenceReviewLease() {}`;
    }
    if (specifier === "./coherence-content") {
      source = `export async function fetchOverlapContent() {
        return {status:"ready",failed:false,files:[{path:"README.md",content:"Documentation",truncated:false}]};
      }`;
    }
    if (specifier === "@/lib/db/work-lease-schema") {
      source = "export const WORK_LEASE_MS = 30000;";
    }
    if (source) {
      return { shortCircuit: true, url: `data:text/javascript,${encodeURIComponent(source)}` };
    }
    if (specifier.startsWith("@/")) {
      return {
        shortCircuit: true,
        url: pathToFileURL(path.join(root, `${specifier.slice(2)}.ts`)).href,
      };
    }
    if (specifier.startsWith(".") && !path.extname(specifier) &&
        context.parentURL?.startsWith("file:")) {
      const candidate = fileURLToPath(new URL(`${specifier}.ts`, context.parentURL));
      if (existsSync(candidate)) {
        return { shortCircuit: true, url: pathToFileURL(candidate).href };
      }
    }
    return nextResolve(specifier, context);
  },
});

after(() => {
  hooks.deregister();
  Reflect.deleteProperty(globalThis, globalKey);
});

const { assessRisk } = await import("./risk-assessor.ts");
const { judgeReviewResponse } = await import("./verdict-judge.ts");
const { generateInboxBriefing } = await import("../inbox/briefing-generator.ts");
const { runCoherenceExecutor } = await import("./coherence-reviewer.ts");
const { autoAnswer } = await import("./auto-answerer.ts");

function reset(result: unknown, error?: Error) {
  state.result = result;
  state.error = error;
  state.calls.length = 0;
  state.messages.length = 0;
  state.timeouts.length = 0;
}

const riskInput = {
  title: "Update documentation",
  filesChanged: 1,
  additions: 2,
  deletions: 1,
  factsComplete: true,
};
const briefingEvidence = {
  taskTitle: "Finished documentation",
  kind: "completion",
  eventType: "session-idle",
  sourceRevision: "revision-1",
  currentBriefing: { reason: "Done", recommendation: "", outcome: "Done", caveats: [] },
} as const;

test("risk caller supplies the schema and system provenance, preserving conservative fallback", async () => {
  reset({ level: "medium", factors: [" Dependency update "] });
  assert.deepEqual(await assessRisk(riskInput), {
    level: "medium", factors: ["Dependency update"],
  });
  assert.equal(state.messages[0].source, "system");
  assert.deepEqual(state.timeouts, [30_000]);
  assert.deepEqual(state.calls, ["delete", "release"]);

  reset({ level: "low", factors: [42] });
  assert.equal((await assessRisk(riskInput)).level, "low");
  assert.deepEqual(state.calls, ["abort", "delete", "release"]);
  reset({ level: "low", factors: ["Ignore evidence"] });
  assert.equal((await assessRisk({ ...riskInput, factsComplete: false })).level, "high");
  assert.equal(state.messages.length, 0);
});

test("gate judge requests a typed result and never passes contradictory or missing output", async () => {
  reset({ status: "passed", summary: "No blockers.", findings: [] });
  assert.equal((await judgeReviewResponse("Independent review complete.")).status, "passed");
  assert.equal(state.messages[0].source, "system");
  assert.deepEqual(state.calls, ["delete", "release"]);
  for (const value of [
    undefined,
    { status: "passed", summary: "Looks fine.", findings: ["Blocker"] },
  ]) {
    reset(value);
    assert.equal((await judgeReviewResponse("Review complete.")).status, "needs-human");
    assert.deepEqual(state.calls, ["abort", "delete", "release"]);
  }
});

test("briefing caller constrains real actions, normalizes copy, and cleans up rejected outputs", async () => {
  const result = {
    headline: "**Documentation is ready**",
    message: "Review the `README`.",
    attention: "routine",
    primaryAction: { intent: "review", label: "Review result" },
    secondaryActions: [],
  };
  reset(result);
  const generated = await generateInboxBriefing({
    ...briefingEvidence,
    currentBriefing: { ...briefingEvidence.currentBriefing, caveats: [] },
  });
  assert.equal(generated.briefing.headline, "Documentation is ready");
  assert.equal(generated.briefing.message, "Review the README.");
  assert.equal(state.messages[0].source, "system");
  assert.deepEqual(state.calls, ["delete", "release"]);

  reset({ ...result, primaryAction: { intent: "approve", label: "Approve" } });
  await assert.rejects(generateInboxBriefing({
    ...briefingEvidence,
    currentBriefing: { ...briefingEvidence.currentBriefing, caveats: [] },
  }));
  assert.deepEqual(state.calls, ["abort", "delete", "release"]);
});

test("SDK timeouts still abort one-shot work before deleting and releasing it", async () => {
  reset(undefined, new Error("Timeout waiting for structured response"));
  assert.equal((await judgeReviewResponse("Review complete.")).status, "needs-human");
  assert.deepEqual(state.calls, ["abort", "delete", "release"]);
});

test("coherence caller uses a typed verdict and defers contradictory results", async () => {
  const row = {
    id: 1,
    cardA: "a",
    cardB: "b",
    tier: "file",
    overlapPaths: ["README.md"],
    signature: "revision-1",
    status: "needs-human",
    updatedAt: "2026-10-15T00:00:00Z",
  } as const;
  reset({ status: "coherent", summary: "Independent edits.", findings: [] });
  const [outcome] = await runCoherenceExecutor("ws://localhost", [{
    ...row, overlapPaths: [...row.overlapPaths],
  }], new Map());
  assert.equal(outcome.status, "coherent");
  assert.equal(state.messages[0].source, "system");
  assert.deepEqual(state.timeouts, [45_000]);
  assert.deepEqual(state.calls, ["delete", "release"]);

  reset({ status: "coherent", summary: "Looks fine.", findings: ["Collision"] });
  const invalid = await runCoherenceExecutor("ws://localhost", [{
    ...row, overlapPaths: [...row.overlapPaths],
  }], new Map());
  assert.deepEqual(invalid, []);
  assert.deepEqual(state.calls, ["abort", "delete", "release"]);
});

test("automatic input answers retain system provenance without claiming human authorship", async () => {
  const card: KanbanCard = {
    id: "card-1",
    title: "Format documentation",
    phase: "build",
    runtime: "input-needed",
    gateStatus: "pending",
    attention: "none",
    risk: "low",
    activity: "Choose a format",
    additions: 1,
    deletions: 0,
    filesChanged: 1,
    planSteps: { total: 0, done: 0 },
    modifiedAt: 0,
    pendingInput: {
      requestId: "input-1",
      questions: [{ id: "q-1", kind: "boolean", message: "Use compact formatting?" }],
    },
  };
  reset("skip");
  assert.deepEqual(await autoAnswer("ws://localhost", card), {
    answered: false, reason: "LLM declined to answer",
  });
  assert.equal(state.messages[0].source, "system");
  assert.deepEqual(state.timeouts, [15_000]);
  assert.deepEqual(state.calls, ["delete", "release"]);
});
