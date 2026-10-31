import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";
import Database from "better-sqlite3";
import { CoordinatorGoalStore, ensureCoordinatorGoalsSchema } from "../db/coordinator-goals.ts";
import { ensureCoordinatorDeliveriesSchema } from "../db/coordinator-deliveries.ts";
import type { KanbanCard } from "../types.ts";

const db = new Database(":memory:");
ensureCoordinatorGoalsSchema(db);
ensureCoordinatorDeliveriesSchema(db);
const store = new CoordinatorGoalStore(db);
const hostUrl = "vscode-local://desktop";
const cards: KanbanCard[] = [];
const state = {
  db, store, cards, connected: true, generation: 1, mode: "coordinate", verified: true,
  calls: [] as { args: Record<string, unknown> }[], judgments: 0,
  beforeJudgment: () => {},
};
Object.assign(globalThis, { __coordinatorTest: state });
const prelude = "const s=globalThis.__coordinatorTest;";
const modules: Record<string, string> = {
  "server-only": "",
  "./coordinator-goal-service": "export const getCoordinatorGoalStore=()=>s.store",
  "./coordinator-authority": "export function currentCoordinatorCards(){if(!s.connected)throw Error('Disconnected');return s.cards}",
  "./coordinator-hosts": "export const getCoordinatorHost=()=>s.connected?{generation:s.generation}:undefined",
  "./coordinator-mode-store": "export const getCoordinatorDefaultMode=()=>s.mode;export const getEffectiveCoordinatorMode=()=>s.mode",
  "./coordinator-goal-events": "export const coordinatorGoalEvents={publish(){}}",
  "./coordinator-goal-decision": "export async function judgeCoordinatorGoal(e){s.judgments++;s.beforeJudgment();return {acceptedItemIds:e.candidates.map(c=>c.itemId),goalCompleted:e.candidates.length+e.priorResults.length===2,needsHuman:false,summary:'Evidence checked'}}",
  "./tool-executor": "export async function executeToolCall(n,args,c){if(!c.isCurrent())throw Error('Stale');s.calls.push({args});const resource=args.cardId??'new-worker';return {success:true,data:{resource,chatUri:'chat',turnId:'turn'}}}",
  "./gate-engine": "export const canAdvancePhase=()=>({allowed:s.verified});export const getGateRunsForCard=()=>[]",
  "./gate-revision": "export const resolveAuthoritativeGateRevision=()=>({ok:true,changesetRef:'source:1'})",
  "./risk-store": "export const getRiskForAutomation=()=> 'high'",
  "../db/schema": "export const getDb=()=>s.db",
  "../inbox/service": "export function projectCoordinatorGoalToInbox(){}",
};
registerHooks({
  resolve(specifier, context, next) {
    if (specifier in modules) return { shortCircuit: true, url: `data:text/javascript,${encodeURIComponent(prelude + modules[specifier])}` };
    if (specifier.startsWith(".") && !specifier.endsWith(".ts")) return next(`${specifier}.ts`, context);
    return next(specifier, context);
  },
});
const { reconcileCoordinatorGoals } = await import("./coordinator-goal-reconciler.ts");
const signal = new AbortController().signal;
function worker(id: string): KanbanCard {
  return { id, title: id, phase: "build", runtime: "idle", gateStatus: "pending", attention: "none", risk: "low",
    activity: "", additions: 1, deletions: 0, filesChanged: 1, sourceRevision: "initial",
    changesetVerified: true, planSteps: { total: 0, done: 0 }, modifiedAt: 1, workingDirectory: "/workspace" };
}
function goal(id: string) {
  let value = store.create({ id, hostUrl, workspaceScope: ["/workspace"], objective: "A then B", acceptanceCriteria: "Integrated result" });
  value = store.addItem(id, value.revision, { id: `${id}-a`, cardId: "a", instructions: "Build API", acceptanceCriteria: "API works", workingDirectory: "/workspace", dependencies: [] });
  value = store.addItem(id, value.revision, { id: `${id}-b`, cardId: "b", instructions: "Integrate API", acceptanceCriteria: "Integration works", workingDirectory: "/workspace", dependencies: [{ itemId: `${id}-a`, kind: "verified" }] });
  return store.update(id, value.revision, { state: "active" });
}

test("persistent A -> verified result -> B survives restart, pauses, and unchanged snapshots", async () => {
  cards.push(worker("a"), worker("b"));
  const initial = goal("pipeline");
  state.connected = false;
  await reconcileCoordinatorGoals(hostUrl, signal);
  assert.equal(state.calls.length, 0);
  state.connected = true;
  state.mode = "observe";
  await reconcileCoordinatorGoals(hostUrl, signal);
  assert.equal(state.calls.length, 0);
  state.mode = "coordinate";
  await reconcileCoordinatorGoals(hostUrl, signal);
  assert.equal(state.calls.length, 1);
  assert.equal(store.get(initial.id)!.items[0].state, "awaiting-result");
  const restored = new CoordinatorGoalStore(db);
  assert.equal(restored.get(initial.id)!.items[0].actionKey, initial.items[0].actionKey);
  await reconcileCoordinatorGoals(hostUrl, signal);
  assert.equal(state.calls.length, 1);
  assert.equal(state.judgments, 0);
  cards[0].lastAgentMessage = "API built and checked";
  cards[0].outcomeEvidence = { chatUri: "chat", turnId: "turn", state: "complete", text: "API built and checked", truncated: false };
  cards[0].sourceRevision = "api-result";
  state.verified = false;
  await reconcileCoordinatorGoals(hostUrl, signal);
  assert.equal(state.calls.length, 1);
  const calls = state.judgments;
  await reconcileCoordinatorGoals(hostUrl, signal);
  assert.equal(state.judgments, calls);
  state.verified = true;
  await reconcileCoordinatorGoals(hostUrl, signal);
  assert.equal(state.calls.length, 2);
  assert.match(String(state.calls[1].args.message), /API built and checked/);
  cards[1].lastAgentMessage = "Integration works";
  cards[1].outcomeEvidence = { chatUri: "chat", turnId: "turn", state: "complete", text: "Integration works", truncated: false };
  cards[1].sourceRevision = "integration-result";
  await reconcileCoordinatorGoals(hostUrl, signal);
  assert.equal(store.get(initial.id)!.state, "completed");
  await reconcileCoordinatorGoals(hostUrl, signal);
  assert.equal(state.calls.length, 2);
});

test("a human pause during independent judgment fences late results and dependency dispatch", async () => {
  const value = goal("paused");
  cards[0] = worker("a");
  await reconcileCoordinatorGoals(hostUrl, signal);
  cards[0].lastAgentMessage = "New API result";
  cards[0].outcomeEvidence = { chatUri: "chat", turnId: "turn", state: "complete", text: "New API result", truncated: false };
  cards[0].sourceRevision = "new-api";
  state.beforeJudgment = () => {
    const current = store.get(value.id)!;
    store.update(value.id, current.revision, { state: "paused" });
  };
  const before = state.calls.length;
  await reconcileCoordinatorGoals(hostUrl, signal);
  assert.equal(store.get(value.id)!.state, "paused");
  assert.equal(store.get(value.id)!.items[0].state, "awaiting-result");
  assert.equal(state.calls.length, before);
  state.beforeJudgment = () => {};
});

test("host generation and accepted-gate drift during judgment prevent dependency effects", async () => {
  for (const drift of ["generation", "gates"]) {
    cards[0] = worker("a");
    const value = goal(`drift-${drift}`);
    await reconcileCoordinatorGoals(hostUrl, signal);
    cards[0].lastAgentMessage = "New bound result";
    cards[0].outcomeEvidence = { chatUri: "chat", turnId: "turn", state: "complete", text: "New bound result", truncated: false };
    cards[0].sourceRevision = "new-result";
    const before = state.calls.length;
    state.beforeJudgment = () => { if (drift === "generation") state.generation++; else state.verified = false; };
    await reconcileCoordinatorGoals(hostUrl, signal);
    assert.equal(state.calls.length, before);
    assert.notEqual(store.get(value.id)!.items[0].state, "completed");
    const current = store.get(value.id)!;
    store.update(value.id, current.revision, { state: "paused" });
    state.beforeJudgment = () => {};
    state.verified = true;
  }
});

test("uncorrelated or truncated outcomes escalate without model work or dependent dispatch", async () => {
  for (const truncated of [false, true]) {
    cards[0] = worker("a");
    const value = goal(`uncorrelated-${truncated}`);
    await reconcileCoordinatorGoals(hostUrl, signal);
    const before = state.calls.length;
    const judgments = state.judgments;
    cards[0].lastAgentMessage = "A later response";
    cards[0].outcomeEvidence = { chatUri: "chat", turnId: truncated ? "turn" : "another-turn",
      state: "complete", text: "A later response", truncated };
    await reconcileCoordinatorGoals(hostUrl, signal);
    assert.equal(store.get(value.id)!.state, "needs-human");
    assert.equal(state.calls.length, before);
    assert.equal(state.judgments, judgments);
  }
});

test("uncertain work recovers its durable identity without resending after restart", async () => {
  cards[0] = worker("a");
  const value = goal("uncertain");
  assert.equal(store.claim(value.id, value.revision, "crashed"), true);
  const item = { ...value.items[0], state: "uncertain" as const };
  store.saveItem(value.id, value.revision, item, "crashed");
  store.release(value.id, "crashed");
  db.prepare("INSERT INTO coordinator_deliveries(audit_key,identity_json) VALUES (?,?)")
    .run(item.actionKey, JSON.stringify({ resource: "a", chatUri: "actual-chat", turnId: "actual-turn" }));
  const before = state.calls.length;
  await reconcileCoordinatorGoals(hostUrl, signal);
  const result = store.get(value.id)!;
  assert.equal(result.state, "needs-human");
  assert.equal(result.items[0].delivery?.turnId, "actual-turn");
  await reconcileCoordinatorGoals(hostUrl, signal);
  assert.equal(state.calls.length, before);
});

test("independent ready work progresses on later ticks without a catalogue change", async () => {
  cards.splice(0, cards.length, worker("a"), worker("b"));
  let value = store.create({
    id: "independent", hostUrl, workspaceScope: ["/workspace"],
    objective: "Two independent reports", acceptanceCriteria: "Both reports verified",
  });
  for (const id of ["a", "b"]) {
    value = store.addItem(value.id, value.revision, {
      id: `independent-${id}`, cardId: id, instructions: `Report ${id}`, acceptanceCriteria: "Complete report",
      workingDirectory: "/workspace", dependencies: [],
    });
  }
  value = store.update(value.id, value.revision, { state: "active" });
  const before = state.calls.length;
  await reconcileCoordinatorGoals(hostUrl, signal);
  await reconcileCoordinatorGoals(hostUrl, signal);
  await reconcileCoordinatorGoals(hostUrl, signal);
  assert.equal(state.calls.length, before + 2);
  assert.deepEqual(store.get(value.id)!.items.map((item) => item.state), ["awaiting-result", "awaiting-result"]);
  const current = store.get(value.id)!;
  store.update(value.id, current.revision, { state: "paused" });
});

test("finished work with unmet overall criteria becomes a human decision", async () => {
  cards.splice(0, cards.length, worker("a"));
  let value = store.create({
    id: "unmet", hostUrl, workspaceScope: ["/workspace"],
    objective: "Integrate system", acceptanceCriteria: "System integrated",
  });
  value = store.addItem(value.id, value.revision, {
    id: "unmet-a", cardId: "a", instructions: "Build API", acceptanceCriteria: "API built",
    workingDirectory: "/workspace", dependencies: [],
  });
  store.update(value.id, value.revision, { state: "active" });
  await reconcileCoordinatorGoals(hostUrl, signal);
  cards[0].outcomeEvidence = { chatUri: "chat", turnId: "turn", state: "complete", text: "API built", truncated: false };
  await reconcileCoordinatorGoals(hostUrl, signal);
  const result = store.get(value.id)!;
  assert.equal(result.items[0].state, "completed");
  assert.equal(result.state, "needs-human");
  assert.match(result.summary!, /overall acceptance criteria remain unmet/);
});

test("queued recovery preserves only the pending-message identity and never resends", async () => {
  cards.splice(0, cards.length, worker("a"), worker("b"));
  const value = goal("queued-recovery");
  assert.equal(store.claim(value.id, value.revision, "crashed"), true);
  const item = { ...value.items[0], state: "uncertain" as const };
  store.saveItem(value.id, value.revision, item, "crashed");
  store.release(value.id, "crashed");
  db.prepare("INSERT INTO coordinator_deliveries(audit_key,identity_json) VALUES (?,?)").run(
    item.actionKey, JSON.stringify({ resource: "a", chatUri: "chat", pendingMessageId: "queued-message", queued: true }),
  );
  const before = state.calls.length;
  await reconcileCoordinatorGoals(hostUrl, signal);
  const result = store.get(value.id)!;
  assert.equal(result.state, "needs-human");
  assert.equal(result.items[0].delivery?.pendingMessageId, "queued-message");
  assert.equal(result.items[0].delivery?.turnId, undefined);
  assert.equal(state.calls.length, before);
});

test("aggregate outcome evidence beyond the judgment budget escalates without a model call", async () => {
  cards.splice(0, cards.length, ...Array.from({ length: 9 }, (_, index) => worker(`budget-${index}`)));
  let value = store.create({
    id: "budget", hostUrl, workspaceScope: ["/workspace"],
    objective: "Review reports", acceptanceCriteria: "All reports accepted",
  });
  for (const card of cards) {
    value = store.addItem(value.id, value.revision, {
      id: card.id, cardId: card.id, instructions: "Produce report", acceptanceCriteria: "Report complete",
      workingDirectory: "/workspace", dependencies: [],
    });
  }
  store.update(value.id, value.revision, { state: "active" });
  for (let index = 0; index < cards.length; index++) await reconcileCoordinatorGoals(hostUrl, signal);
  for (const card of cards) {
    card.outcomeEvidence = { chatUri: "chat", turnId: "turn", state: "complete", text: "x".repeat(8_000), truncated: false };
  }
  const before = state.judgments;
  await reconcileCoordinatorGoals(hostUrl, signal);
  assert.equal(store.get(value.id)!.state, "needs-human");
  assert.match(store.get(value.id)!.summary!, /bounded review window/);
  assert.equal(state.judgments, before);
});
