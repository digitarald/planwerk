import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { after, test } from "node:test";
import ts from "typescript";
import type { Phase, KanbanCard } from "../types.ts";

const state: {
  phase?: Phase; writes: Phase[]; owned: boolean; card?: Partial<KanbanCard>;
  gateReads: unknown[][]; projectGates: boolean;
} = { writes: [], owned: true, gateReads: [], projectGates: false };
const key = "__planwerkEnrichPhaseTest";
Object.defineProperty(globalThis, key, { value: state, configurable: true });
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    const mocks: Record<string, string> = {
      "server-only": "export {}",
      "../db/schema": "export function getDb(){return {};}",
      "../db/session-ownership": `export function isSessionOwnedByHost(){return globalThis["${key}"].owned;} export function getSessionOwnership(){return {quarantined:true};}`,
      "@/lib/types": "export function normalizeChangesetRef(value){return value;} export function sourceChangesetRef(value){return value;}",
      "@/lib/orchestrator/gate-engine": `
        export function getPersistedCardPhase(){return globalThis["${key}"].phase;}
        export function setCardPhase(id,phase){globalThis["${key}"].writes.push(phase);}
        export function getNextPhase(phase){return globalThis["${key}"].projectGates ? {plan:'build',build:'review'}[phase] : undefined;}
        export function canAdvancePhase(){return {allowed:false,pendingGates:[{gateType:'review',gateName:'plan-review'}]};}
        export function deriveGateStatus(...args){globalThis["${key}"].gateReads.push(args);return "pending";}`,
      "@/lib/orchestrator/risk-store": "export function getAuthoritativeCardRisk(){return {status:'current',assessment:{factors:[]}};}",
      "@/lib/orchestrator/risk-authority": "export function riskAutomationPolicy(){return {current:true,level:'medium'};}",
      "@/lib/orchestrator/automation-eligibility": "export function isCardAutomationEligible(){return false;}",
      "@/lib/orchestrator/review-executor": "export function getReviewRunsForCard(){return [];}",
      "@/lib/orchestrator/coherence-engine": "export function buildCoherenceSummary(){}",
      "@/lib/orchestrator/status-history-store": "export function getCardStatusHistory(){return [];} export function recordCardStatus(){}",
      "./map-session": `export function mapSessionToCard(){return {phase:'ship',attention:'none',runtime:'idle',...globalThis["${key}"].card};}`,
    };
    if (mocks[specifier]) return { shortCircuit: true, url: `data:text/javascript,${encodeURIComponent(mocks[specifier])}` };
    if (specifier === "./types") return nextResolve("./types.ts", context);
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.endsWith("/lib/ahp/enrich-card.ts")) return {
      shortCircuit: true, format: "module",
      source: ts.transpileModule(readFileSync(new URL(url), "utf8"), {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ESNext },
      }).outputText,
    };
    return nextLoad(url, context);
  },
});
after(() => { hooks.deregister(); Reflect.deleteProperty(globalThis, key); });
const { enrichSessionToCard } = await import("./enrich-card.ts");
const summary = { resource: "test", title: "Test", status: 65, provider: "fake", createdAt: "", modifiedAt: "" };

test("projection never advances a persisted phase, including Define and archived cards", () => {
  for (const phase of ["define", "plan", "build", "review"] as Phase[]) {
    state.phase = phase;
    state.writes.length = 0;
    assert.equal(enrichSessionToCard(summary).phase, phase);
    assert.deepEqual(state.writes, []);
  }
});
test("cached projection does not seed phases; initial live projection may seed once", () => {
  state.phase = undefined;
  state.writes.length = 0;
  enrichSessionToCard(summary, undefined, { recordStatus: false });
  assert.deepEqual(state.writes, []);
  enrichSessionToCard(summary);
  assert.deepEqual(state.writes, ["ship"]);
});

test("ambiguous host identity projects conservative display only without reading other-host phase authority", () => {
  state.owned = false;
  state.phase = "review";
  state.writes.length = 0;
  const card = enrichSessionToCard(summary, undefined, { hostUrl: "ws://other" });
  assert.equal(card.phase, "define");
  assert.equal(card.gateStatus, "pending");
  assert.equal(card.attention, "stale");
  assert.deepEqual(state.writes, []);
  state.owned = true;
});

test("a pending plan on a Build card projects the plan gate without moving phase", () => {
  state.phase = "build";
  state.projectGates = true;
  state.gateReads.length = state.writes.length = 0;
  state.card = {
    runtime: "input-needed", planContentHash: "plan:parent",
    changesetVerified: true, sourceRevision: "source:code",
  };
  const card = enrichSessionToCard(summary, undefined, {
    pendingInput: { requestId: "request", questions: [], planReview: { questionId: "choice", actionIds: ["interactive"] } },
  });
  assert.equal(card.phase, "build");
  assert.equal(state.gateReads[0][1], "plan");
  assert.equal(state.gateReads[0][2], "build");
  assert.equal(state.gateReads[0][4], "plan:parent");
  assert.equal(card.gateBlocker, "Plan review not started");
  assert.deepEqual(state.writes, []);
  state.gateReads.length = 0;
  const cleared = enrichSessionToCard(summary, undefined, { pendingInput: null });
  assert.equal(cleared.pendingInput, undefined);
  assert.equal(state.gateReads[0][1], "build");
  state.card = undefined;
  state.projectGates = false;
});
