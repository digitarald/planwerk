import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { after, test } from "node:test";
import type { KanbanCard } from "../types.ts";

const card: KanbanCard = { id: "server-session", title: "Server-owned task", phase: "build",
  runtime: "idle", gateStatus: "pending", attention: "none", risk: "low", activity: "",
  filesChanged: 0, additions: 0, deletions: 0, planSteps: { total: 0, done: 0 }, modifiedAt: 1 };
const state = { connected: true, cards: [card], selected: undefined as KanbanCard | undefined,
  host: "", scope: [] as string[], revision: 3, mutations: 0, sdkCalls: 0 };
Object.assign(globalThis, { __coordinatorHttp: state });
const prelude = "const s=globalThis.__coordinatorHttp;";
const modules: Record<string, string> = {
  "next/server": "export const NextResponse=Response;export class NextRequest extends Request{}",
  "server-only": "",
  "@/lib/db/cto-continuity": "export const getCtoContinuityStore=()=>{}",
  "@/lib/db/sdk-observability": "export const createSdkObservabilityIngestor=()=>{}",
  "@/lib/orchestrator/cto-approval": "export const getCtoTurnTimeoutMs=()=>1000;export const createCtoPermissionPolicy=()=>{}",
  "@/lib/orchestrator/cto-session-manager": "export class CtoSessionLeaseBusyError extends Error{};export class CtoSessionManager{}",
  "@/lib/orchestrator/copilot-session": "export const invalidateRuntimeForCleanupFailure=()=>{};export const releaseRuntimeLease=()=>{}",
  "@/lib/orchestrator/board-context": "export const buildBoardContext=cards=>JSON.stringify(cards);export const buildCardDetail=card=>{s.selected=card;return JSON.stringify(card)}",
  "@/lib/orchestrator/orchestrator-tools": "export const ORCHESTRATOR_TOOLS=[];export const createOrchestratorSdkTools=()=>[]",
  "@/lib/orchestrator/orchestrator-stream": "export const createSdkEventMapper=()=>{};export const isPrimarySdkSessionTermination=()=>false;export const mapSdkFailure=()=>({type:'error',message:'Test runtime unavailable'})",
  "@/lib/orchestrator/model": "export const selectOrchestratorModel=()=>{}",
  "@/lib/orchestrator/sdk-runtime": "export const acquireCopilotRuntimeClient=async()=>{s.sdkCalls++;throw Error('Isolated test runtime unavailable')};export const classifyCopilotFailure=()=>{};export const isCopilotRuntimeInvalidatingFailure=()=>false",
  "@/lib/orchestrator/sdk-lifecycle": "export const withSdkCleanupTimeout=()=>{}",
  "@/lib/orchestrator/tool-executor": "export const executeToolCall=()=>{};export const getAuthoritativeApprovalBinding=()=>{}",
  "@/lib/orchestrator/coordinator-authority": "export function currentCoordinatorCards(scope){if(!s.connected)throw Error('Host disconnected');s.host=scope.hostUrl;s.scope=scope.workspaceScope;return s.cards}",
  "@/lib/orchestrator/coordinator-mode-store": "export const getCoordinatorDefaultMode=()=> 'observe'",
  "@/lib/orchestrator/coordinator-goal-service": "export const listCoordinatorGoals=()=>[];export function manageCoordinatorGoal(scope,args){if(args.revision!==s.revision)throw Error('Goal changed');s.mutations++;return {id:args.goalId,revision:++s.revision,state:args.action==='pause'?'paused':args.action==='cancel'?'cancelled':'active'}}",
  "@/lib/orchestrator/coordinator-goal-reconciler": "export const coordinatorGoalWaitReason=()=>undefined",
};
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier in modules) return { shortCircuit: true, url: `data:text/javascript,${encodeURIComponent(prelude + modules[specifier])}` };
    if (specifier.startsWith("@/")) return next(new URL(`../../${specifier.slice(2)}.ts`, import.meta.url).href, context);
    if (specifier.startsWith(".") && !/\.[a-z]+$/i.test(specifier)) return next(`${specifier}.ts`, context);
    return next(specifier, context);
  },
});
const { NextRequest } = await import("next/server");
const chat = await import("../../app/api/orchestrator/chat/route.ts");
const goals = await import("../../app/api/orchestrator/goals/route.ts");
const base = "http://127.0.0.1:3000";
function request(path: string, body: unknown, origin = base) {
  return new NextRequest(`${base}${path}`, {
    method: "POST", headers: { origin, host: "127.0.0.1:3000", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
after(() => { hooks.deregister(); Reflect.deleteProperty(globalThis, "__coordinatorHttp"); });

test("chat accepts the desktop host and scoped server selection, never client-supplied cards", async () => {
  const response = await chat.POST(request("/api/orchestrator/chat", {
    message: "What is the status?", hostUrl: "vscode-local://desktop", workspaceScope: ["/workspace"],
    selectedCardId: card.id, cards: [{ ...card, title: "Forged task" }],
  }));
  assert.equal(response.status, 200);
  assert.equal(state.host, "vscode-local://desktop");
  assert.deepEqual(state.scope, ["/workspace"]);
  assert.equal(state.selected, card);
  const text = await response.text();
  assert.match(text, /Server-owned task/);
  assert.doesNotMatch(text, /Forged task/);
  state.selected = undefined;
  await chat.POST(request("/api/orchestrator/chat", {
    message: "Status?", hostUrl: "vscode-local://desktop", workspaceScope: [], selectedCardId: "out-of-scope",
  }));
  assert.equal(state.selected, undefined);
});

test("invalid scope, disconnected hosts and foreign origins fail before SDK use", async () => {
  const before = state.sdkCalls;
  assert.equal((await chat.POST(request("/api/orchestrator/chat", { message: "Status?" }))).status, 400);
  assert.equal((await chat.POST(request("/api/orchestrator/chat", {
    message: "Status?", hostUrl: "https://example.com", workspaceScope: [],
  }))).status, 400);
  state.connected = false;
  assert.equal((await chat.POST(request("/api/orchestrator/chat", {
    message: "Status?", hostUrl: "vscode-local://desktop", workspaceScope: [],
  }))).status, 409);
  state.connected = true;
  assert.equal((await chat.POST(request("/api/orchestrator/chat", { message: "Status?" }, "https://foreign.test"))).status, 403);
  assert.equal(state.sdkCalls, before);
});

test("goal controls enforce local guards, command shape and revision failures", async () => {
  const body = { hostUrl: "vscode-local://desktop", workspaceScope: [], goalId: "goal", revision: 3,
    action: "pause", commandId: "616664ab-7a93-4a2a-a9c5-f185c2de1ec7" };
  assert.equal((await goals.POST(request("/api/orchestrator/goals", body, "https://foreign.test"))).status, 403);
  assert.equal((await goals.POST(request("/api/orchestrator/goals", { ...body, commandId: "invalid" }))).status, 409);
  const response = await goals.POST(request("/api/orchestrator/goals", body));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).goal.state, "paused");
  assert.equal((await goals.POST(request("/api/orchestrator/goals", { ...body, commandId: crypto.randomUUID() }))).status, 409);
  assert.equal(state.mutations, 1);
});
