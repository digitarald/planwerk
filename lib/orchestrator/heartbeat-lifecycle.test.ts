import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { KanbanCard } from "../types.ts";
import type { CoordinatorMode } from "./coordinator-mode.ts";
import { hashPlanContent } from "../ahp/plan-source.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

const state = {
  mode: "coordinate" as CoordinatorMode,
  hosts: [] as { hostUrl: string; cards: KanbanCard[] }[],
  phases: new Map<string, string>(),
  assessed: new Set<string>(),
  digest: "facts-1",
  assessments: [] as string[],
  phaseWrites: [] as string[],
  writes: [] as string[],
  reviewedPhases: [] as string[],
  requirePlanReview: false,
  reviewRef: "",
  wipLimit: 10,
  intervalMs: 60_000,
  assess: async () => {},
  db: {
    prepare() {
      return {
        get(id: string) {
          return state.phases.has(id) ? { phase: state.phases.get(id) } : undefined;
        },
        run() {},
      };
    },
  },
};
const globalKey = "__planwerkHeartbeatLifecycleTest";
Object.defineProperty(globalThis, globalKey, { value: state, configurable: true });
const s = `globalThis["${globalKey}"]`;
const root = path.resolve(import.meta.dirname, "../..");
const mocks: Record<string, string> = {
  "server-only": "export {}",
  "@/lib/db/schema": `export function getDb() { return ${s}.db; }`,
  "./skill-config": `export function loadConfig() {
    return {
      orchestrator:{heartbeatInterval:${s}.intervalMs,autoTriggerGates:true,autoAdvancePhases:true,
        autoInjectReviews:true,staleThreshold:60000},
      coherence:{enabled:false},wipLimits:{build:${s}.wipLimit},
      reviewPolicy:{low:{autoApprovePlan:true}}
    };
  }`,
  "./review-executor": `export function getActiveReviewRuns(){return []}
    export function getLatestReviewRun(){return null}
    export function getRequiredReviewSkills(){return ${s}.requirePlanReview ? [{id:"plan-critic",prompt:"/rubber-duck",autoFix:true}] : []}
    export function isReviewResultReady(){return false}
    export function shouldStartReview(){return false}
    export async function startReview(_host,_session,_card,_skill,_transition,_risk,ref){
      ${s}.reviewRef=ref;${s}.writes.push("review"); return {success:true,started:true}}
    export async function processReviewResult(){return null}`,
  "./gate-engine": `export function canAdvancePhase(){return {
      allowed:!${s}.requirePlanReview,
      pendingGates:${s}.requirePlanReview ? [{gateType:"review",gateName:"plan-critic"}] : []}}
    export function setCardPhase(id,phase){${s}.phases.set(id,phase);${s}.phaseWrites.push(id)}
    export function getNextPhase(){return "review"}
    export function startGateRun(){return 1}
    export function getGateRunsForCard(){return []}
    export function completeGateRun(){}
    export function executeGateCommand(){${s}.writes.push("command")}`,
  "./risk-store": `export function getAuthoritativeCardRisk(id){
      return ${s}.assessed.has(id) ? {status:"current",currentDigest:${s}.digest,
        assessment:{riskDigest:${s}.digest}} : {status:"missing"};
    }
    export function getAuthoritativeRiskSnapshot(hostUrl,cardId){
      return {hostUrl,cardId,digest:${s}.digest,input:{title:cardId}};
    }
    export function persistAuthoritativeRisk(snapshot){${s}.assessed.add(snapshot.cardId);return true}`,
  "./risk-authority": `export function riskAutomationPolicy(risk){
    return {current:risk.status==="current",level:"low",reason:"Assessment required"};
  }`,
  "./risk-assessor": `export async function assessRisk(input){
    ${s}.assessments.push(input.title);await ${s}.assess();return {level:"low",factors:[]};
  }`,
  "./risk-reassessment": `export async function reassessAndPersistRisk(id,snapshot,assess,persist){
    const result=await assess(snapshot.input);
    persist(snapshot,result.level,result.factors,"copilot");return result;
  }`,
  "./auto-answerer": `export function shouldAutoAnswer(){return true}
    export async function autoAnswer(){${s}.writes.push("answer");return {answered:true}}`,
  "@/lib/ahp/session-messenger": `export async function answerInput(){
      ${s}.writes.push("approve");return {success:true};
    }
    export async function disposePeerChat(){}
    export async function verifyPlanReviewSource(){}
    export async function submitPlanFeedback(){${s}.writes.push("feedback");return {success:true}}`,
  "./coherence-engine": "export function syncCoherence(){return []}",
  "./coordinator-mode-store": `export function getEffectiveCoordinatorMode(){return ${s}.mode}`,
  "./coherence-reviewer": "export async function runCoherenceExecutor(){return []}",
  "./phase-advance": "export function advanceReviewToShip(){return {advanced:true,blockedBy:[]}}",
  "./review-chat-cleanup": "export async function retryPendingReviewChatCleanup(){}",
  "./gate-revision": `export function resolveAuthoritativeGateRevision(_db,_card,phase){
    ${s}.reviewedPhases.push(phase);
    if (${s}.requirePlanReview && phase!=="plan") return {ok:false,reason:"No code evidence"};
    return {ok:true,changesetRef:phase==="plan" ? ${JSON.stringify(hashPlanContent("# Plan"))} : "source-1",
      sourceRevision:"source-1",hostUrl:"host",
      plan:{content:"# Plan",changesetRef:${JSON.stringify(hashPlanContent("# Plan"))},
        source:{sessionUri:_card,uri:"file:///host/plan.md",requestId:"request"}}};
  }`,
};
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (mocks[specifier]) {
      return { shortCircuit: true, url: `data:text/javascript,${encodeURIComponent(mocks[specifier])}` };
    }
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
const {
  invalidateHostWork,
  requestHeartbeatTick,
  startHeartbeat,
  stopHeartbeat,
} = await import("./heartbeat.ts");

after(async () => {
  await stopHeartbeat();
  hooks.deregister();
  Reflect.deleteProperty(globalThis, globalKey);
});

function card(id: string): KanbanCard {
  return { id, title: id, phase: "plan", runtime: "idle", isArchived: false } as KanbanCard;
}

function reset(cards: KanbanCard[]) {
  state.mode = "coordinate";
  state.hosts = [{ hostUrl: "host", cards }];
  state.phases.clear();
  state.assessed.clear();
  state.assessments.length = 0;
  state.phaseWrites.length = 0;
  state.writes.length = 0;
  state.reviewedPhases.length = 0;
  state.requirePlanReview = false;
  state.reviewRef = "";
  state.digest = "facts-1";
  state.wipLimit = 10;
  state.intervalMs = 60_000;
  state.assess = async () => {};
}

async function until(predicate: () => boolean) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail("Heartbeat condition was not reached");
}

test("mode downgrade during heartbeat risk assessment prevents dispatch and phase advancement", async () => {
  reset([card("downgrade")]);
  const pending = deferred();
  state.assess = () => pending.promise;
  startHeartbeat(() => state.hosts, () => {});
  await until(() => state.assessments.length === 1);
  state.mode = "observe";
  pending.resolve();
  await until(() => state.assessed.has("downgrade"));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(state.phaseWrites, []);
  assert.deepEqual(state.writes, []);
  await stopHeartbeat();
});

test("downgrade during assessment cannot use captured permission to answer input", async () => {
  const inputCard = {
    ...card("input-downgrade"),
    phase: "define", runtime: "input-needed", pendingInput: { requestId: "request", questions: [] },
  } as unknown as KanbanCard;
  reset([inputCard]);
  const pending = deferred();
  state.assess = () => pending.promise;
  startHeartbeat(() => state.hosts, () => {});
  await until(() => state.assessments.length === 1);
  state.mode = "observe";
  pending.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(state.writes, []);
  await stopHeartbeat();
});

test("a Build card awaiting plan approval reviews the plan without requiring code evidence or moving phase", async () => {
  reset([{
    ...card("parent"), phase: "build", runtime: "input-needed",
    pendingInput: {
      requestId: "request",
      planReview: { questionId: "choice", actionIds: ["interactive"], planUri: "file:///host/plan.md" },
      questions: [{ id: "choice", kind: "single-select", options: [{ id: "interactive", label: "Implement" }] }],
    },
  } as KanbanCard]);
  state.requirePlanReview = true;
  state.phases.set("parent", "build");
  startHeartbeat(() => state.hosts, () => {});
  await until(() => state.writes.includes("review"));
  await stopHeartbeat();
  assert.equal(state.reviewRef, hashPlanContent("# Plan"));
  assert(state.reviewedPhases.every((phase) => phase === "plan"));
  assert.deepEqual(state.phaseWrites, []);
  assert(!state.writes.includes("answer"));
  assert(!state.writes.includes("approve"));
});

test("an unsupported recognized plan request never becomes a generic auto-answer", async () => {
  reset([{
    ...card("unsupported"), phase: "build", runtime: "input-needed",
    pendingInput: { requestId: "request", planReview: null, questions: [] },
  } as KanbanCard]);
  startHeartbeat(() => state.hosts, () => {});
  await until(() => state.assessed.has("unsupported"));
  await new Promise<void>((resolve) => setImmediate(resolve));
  await stopHeartbeat();
  assert.deepEqual(state.writes, []);
  assert.deepEqual(state.phaseWrites, []);
});

test("retiring a host during assessment prevents stale risk/phase writes without needing live streams", async () => {
  reset([card("disconnect")]);
  const pending = deferred();
  state.assess = () => pending.promise;
  startHeartbeat(() => state.hosts, () => {});
  await until(() => state.assessments.length === 1);
  state.hosts = [];
  invalidateHostWork("host");
  pending.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(state.assessed.size, 0);
  assert.deepEqual(state.phaseWrites, []);
  assert.deepEqual(state.writes, []);
  await stopHeartbeat();
});

test("changed authoritative source during assessment cannot persist risk or advance a stale phase", async () => {
  reset([card("source")]);
  const pending = deferred();
  state.assess = () => pending.promise;
  startHeartbeat(() => state.hosts, () => {});
  await until(() => state.assessments.length === 1);
  state.digest = "facts-2";
  pending.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(state.assessed.size, 0);
  assert.deepEqual(state.phaseWrites, []);
  await stopHeartbeat();
});

test("in-place phase changes during assessment invalidate the originally captured operation", async () => {
  reset([card("phase-change")]);
  const pending = deferred();
  state.assess = () => pending.promise;
  startHeartbeat(() => state.hosts, () => {});
  await until(() => state.assessments.length === 1);
  state.hosts[0].cards[0].phase = "review";
  pending.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(state.assessed.size, 0);
  assert.deepEqual(state.phaseWrites, []);
  await stopHeartbeat();
});

test("restart does not wait for a stalled nonmutating assessment or share its revoked authority", async () => {
  reset([card("restart")]);
  const pending = deferred();
  state.assess = () => pending.promise;
  startHeartbeat(() => state.hosts, () => {});
  await until(() => state.assessments.length === 1);
  await stopHeartbeat();
  state.assess = async () => {};
  startHeartbeat(() => state.hosts, () => {});
  await until(() => state.assessed.has("restart"));
  pending.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(state.phaseWrites, ["restart"]);
  await stopHeartbeat();
});

test("cards remain serial and persisted phase occupancy preserves WIP admission", async () => {
  reset([card("first"), card("second")]);
  state.wipLimit = 1;
  const first = deferred();
  state.assess = () => state.assessments.length === 1 ? first.promise : Promise.resolve();
  startHeartbeat(() => state.hosts, () => {});
  await until(() => state.assessments.length === 1);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(state.assessments, ["first"]);
  first.resolve();
  await until(() => state.assessments.length === 2);
  await new Promise<void>((resolve) => setImmediate(resolve));
  await stopHeartbeat();
  assert.deepEqual(state.phaseWrites, ["first"]);
});

test("duplicate host/card snapshots deduplicate and dirty-key wakes process only the requested card", async () => {
  reset([card("dirty-a"), card("dirty-b")]);
  state.mode = "observe";
  state.hosts.push({ hostUrl: "host", cards: [...state.hosts[0].cards] });
  startHeartbeat(() => state.hosts, () => {});
  await until(() => state.assessments.length === 2);
  await new Promise<void>((resolve) => setImmediate(resolve));
  state.assessed.clear();
  requestHeartbeatTick("host", "dirty-b");
  requestHeartbeatTick("host", "dirty-b");
  await until(() => state.assessments.length === 3);
  await stopHeartbeat();
  assert.deepEqual(state.assessments, ["dirty-a", "dirty-b", "dirty-b"]);
});

test("host starting order rotates between event sweeps", async () => {
  reset([card("host-a")]);
  state.mode = "observe";
  state.hosts.push({ hostUrl: "other-host", cards: [card("host-b")] });
  startHeartbeat(() => state.hosts, () => {});
  await until(() => state.assessments.length === 2);
  await new Promise<void>((resolve) => setImmediate(resolve));
  state.assessed.clear();
  requestHeartbeatTick();
  await until(() => state.assessments.length === 4);
  await stopHeartbeat();
  assert.deepEqual(state.assessments, ["host-a", "host-b", "host-b", "host-a"]);
});

test("periodic recovery still scans cards when no event wakeup is delivered", async () => {
  reset([card("recovery")]);
  state.mode = "observe";
  state.intervalMs = 5;
  startHeartbeat(() => state.hosts, () => {});
  await until(() => state.assessed.has("recovery"));
  state.assessed.clear();
  await new Promise<void>((resolve) => setTimeout(resolve, 12));
  assert.ok(state.assessments.length >= 2);
  await stopHeartbeat();
});
