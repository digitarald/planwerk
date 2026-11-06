import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { after, beforeEach, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import Database from "better-sqlite3";

import { CoordinatorGoalStore, ensureCoordinatorGoalsSchema } from "../db/coordinator-goals.ts";
import { ensureCoordinatorDeliveriesSchema } from "../db/coordinator-deliveries.ts";
import type { KanbanCard } from "../types.ts";

const db = new Database(":memory:");
ensureCoordinatorGoalsSchema(db);
ensureCoordinatorDeliveriesSchema(db);
const store = new CoordinatorGoalStore(db);
const hostUrl = "local://policy-test";
const source = { sessionUri: "review-card", uri: "file:///workspace/plan.md" };
const state = {
  db, store, cards: [] as KanbanCard[], mode: "active", policy: "policy-1", generation: 1,
  freshness: "current", madeEdits: false, reviewJudgments: 0, goalJudgments: 0,
  reviewCommits: [] as { reviewStatus: string; gateStatus: string; sourceGuard?: unknown }[],
  reviewRow: {
    id: 1, card_id: "review-card", skill_id: "plan-review", phase_transition: "plan->build",
    status: "extracting", iteration: 1, max_iterations: 3, changeset_ref: "plan:hash",
    turn_id: "review-turn", chat_uri: "review-chat", plan_source_json: JSON.stringify(source),
    source_digest: "source-digest",
  },
  plan: { ok: true, changesetRef: "plan:hash", sourceRevision: "source:1",
    plan: { source, content: "The complete parent plan", changesetRef: "plan:hash" } },
  afterPlanVerification: () => {},
  afterGoalJudgment: () => {},
};
const globalKey = "__reviewGoalPolicyTest";
Object.defineProperty(globalThis, globalKey, { value: state, configurable: true });
const prelude = `const s=globalThis["${globalKey}"];`;
const modules: Record<string, string> = {
  "server-only": "",
  "@/lib/db/schema": "export const getDb=()=>s.db",
  "../db/schema": "export const getDb=()=>s.db",
  "../decisions/config.ts": 'export const decisionStillCurrent=(family,version,outcome)=>s.mode==="active"&&outcome.policyKey===s.policy',
  "@/lib/db/review-run-store": `
    export const claimReviewJudgment=()=>s.reviewRow;
    export const failOwnedReviewIfSourceChanged=()=>s.freshness;
    export function commitOwnedReviewOutcome(db,id,owner,outcome){s.reviewCommits.push(outcome);return true}
    export const renewReviewJudgmentLease=()=>true;
    export function claimReviewStart(){}
    export function linkOwnedReviewStartGate(){}
    export function renewReviewStartLease(){}`,
  "@/lib/ahp/session-messenger": `
    export const fetchChatTurnById=async()=>({});
    export const fetchTurnById=async()=>({});
    export async function verifyPlanReviewSource(){await Promise.resolve();s.afterPlanVerification()}
    export function injectMessage(){}
    export function startPeerChatReview(){}
    export function disposePeerChat(){}`,
  "./skill-config": `
    export const loadConfig=()=>({});
    export const shouldFollowEdits=()=>true;
    export function getApplicableSkills(){}
    export function getEffectiveMaxIterations(){}`,
  "./gate-engine": `
    export const canAdvancePhase=()=>({allowed:true});
    export const getGateRunsForCard=()=>[];
    export function startGateRun(){}
    export function completeGateRun(){}`,
  "@/lib/types": "export const normalizeChangesetRef=(value)=>value??''",
  "./review-evidence": "export const extractReviewEvidence=()=>({response:'Complete independent review',madeEdits:s.madeEdits})",
  "./verdict-judge": `export async function judgeReviewResponse(){
    s.reviewJudgments++;await Promise.resolve();
    return {status:"passed",summary:"Independent evidence accepted",findings:[],
      decisionBinding:{policyKey:s.policy,version:"review-v1"}};
  }`,
  "./risk-store": "export const getRiskForAutomation=()=> 'high'",
  "./review-start-cancellation": "export function terminalizeCancelledReviewStart(){}",
  "./review-start-state": `
    export function finalizeOwnedReviewDispatch(){}
    export function persistReviewStartFailure(){}
    export function prepareOwnedReviewDispatch(){}
    export function reconcileRecoveredReviewDispatch(){}
    export function shouldStartReviewForRun(){}`,
  "./review-chat-cleanup": "export const attemptReviewPeerChatCleanup=async()=>true",
  "@/lib/ahp/peer-review-dispatch": "export class PeerChatCleanupRequiredError extends Error{}",
  "@/lib/db/work-lease-schema": "export const WORK_LEASE_MS=30000",
  "./operation-context": "export function assertOperationCurrent(){};export const getOperationSignal=()=>undefined",
  "./gate-revision": "export const resolveAuthoritativeGateRevision=()=>s.plan",
  "./review-prompt": "export function appendPlanReviewEvidence(){}",
  "./coordinator-goal-service": "export const getCoordinatorGoalStore=()=>s.store",
  "./coordinator-authority": "export const currentCoordinatorCards=()=>s.cards",
  "./coordinator-hosts": "export const getCoordinatorHost=()=>({generation:s.generation})",
  "./coordinator-mode-store": "export const getCoordinatorDefaultMode=()=> 'coordinate';export const getEffectiveCoordinatorMode=()=> 'coordinate'",
  "./coordinator-goal-events": "export const coordinatorGoalEvents={publish(){}}",
  "./coordinator-goal-decision": `export async function judgeCoordinatorGoal(evidence){
    s.goalJudgments++;const policyKey=s.policy;await Promise.resolve();s.afterGoalJudgment();
    return {acceptedItemIds:evidence.candidates.map(item=>item.itemId),goalCompleted:true,needsHuman:false,
      summary:"Independently accepted",decisionBindings:[{policyKey,version:"goal-item-v1"},{policyKey,version:"goal-overall-v1"}]};
  }`,
  "./tool-executor": 'export function executeToolCall(){throw Error("Unexpected delegation")}',
  "../inbox/service": "export function projectCoordinatorGoalToInbox(){}",
};
const root = path.resolve(import.meta.dirname, "../..");
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier in modules) return { shortCircuit: true, url: `data:text/javascript,${encodeURIComponent(prelude + modules[specifier])}` };
    if (specifier.startsWith("@/")) return { shortCircuit: true, url: pathToFileURL(path.join(root, `${specifier.slice(2)}.ts`)).href };
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
  db.close();
});
beforeEach(() => {
  state.mode = "active";
  state.policy = "policy-1";
  state.freshness = "current";
  state.madeEdits = false;
  state.reviewJudgments = state.goalJudgments = 0;
  state.reviewCommits.length = 0;
  state.afterPlanVerification = state.afterGoalJudgment = () => {};
});
const { processReviewResult } = await import("./review-executor.ts");
const { reconcileCoordinatorGoals } = await import("./coordinator-goal-reconciler.ts");
const signal = new AbortController().signal;

async function review() { return processReviewResult(hostUrl, "review-card", 1, "plan:hash"); }

test("review rechecks the active policy after asynchronous complete-plan source verification", async () => {
  for (const change of ["policy", "mode"]) {
    state.mode = "active";
    state.policy = "policy-1";
    state.reviewCommits.length = 0;
    state.afterPlanVerification = () => {
      if (change === "policy") state.policy = "policy-2";
      else state.mode = "legacy";
    };
    const result = await review();
    assert.equal(result?.status, "needs-human");
    assert.equal(result?.action, "escalated");
    assert.equal(state.reviewCommits.length, 1);
    assert.equal(state.reviewCommits[0].reviewStatus, "escalated");
    assert.equal(state.reviewCommits[0].gateStatus, "failed");
  }
});

test("current review decisions still require verified plan provenance and retain the commit source guard", async () => {
  const result = await review();
  assert.equal(result?.status, "passed");
  assert.deepEqual(state.reviewCommits[0].sourceGuard, { hostUrl, changesetRef: "plan:hash", sourceRevision: "source:1" });
  state.reviewCommits.length = 0;
  state.afterPlanVerification = () => { throw new Error("Complete parent plan is unavailable"); };
  const failed = await review();
  assert.equal(failed?.status, "needs-human");
  assert.equal(state.reviewCommits[0].reviewStatus, "escalated");
});

test("a reviewer edit or stale review source cannot pass an accepted model judgment", async () => {
  state.madeEdits = true;
  assert.equal((await review())?.status, "needs-human");
  assert.equal(state.reviewCommits[0].reviewStatus, "escalated");
  state.reviewCommits.length = 0;
  state.freshness = "stale";
  const before = state.reviewJudgments;
  assert.equal((await review())?.action, "re-iterate");
  assert.equal(state.reviewJudgments, before);
  assert.equal(state.reviewCommits.length, 0);
});

function awaitingGoal(id: string) {
  state.cards.splice(0, state.cards.length, {
    id: "worker", title: "Worker", phase: "build", runtime: "idle", gateStatus: "pending",
    attention: "none", risk: "low", activity: "", additions: 0, deletions: 0, filesChanged: 0,
    changesetVerified: true, planSteps: { total: 0, done: 0 }, modifiedAt: 1, workingDirectory: "/workspace",
    lastAgentMessage: "Measured result",
    outcomeEvidence: { chatUri: "worker-chat", turnId: "worker-turn", state: "complete", text: "Measured result", truncated: false },
  });
  let goal = store.create({ id, hostUrl, workspaceScope: ["/workspace"], objective: "Verify result", acceptanceCriteria: "Result measured" });
  goal = store.addItem(id, goal.revision, {
    id: `${id}-item`, cardId: "worker", instructions: "Measure result", acceptanceCriteria: "Result measured",
    workingDirectory: "/workspace", dependencies: [],
  });
  goal = store.update(id, goal.revision, { state: "active" });
  assert.equal(store.claim(id, goal.revision, "setup"), true);
  goal = store.saveItem(id, goal.revision, {
    ...goal.items[0], state: "awaiting-result", baseline: "before-result",
    delivery: { chatUri: "worker-chat", turnId: "worker-turn" },
  }, "setup");
  store.release(id, "setup");
  return goal;
}

test("goal persistence rejects policy and active-mode changes after awaited judgment", async () => {
  for (const change of ["policy", "mode"]) {
    state.mode = "active";
    state.policy = "policy-1";
    const goal = awaitingGoal(`changed-${change}`);
    state.afterGoalJudgment = () => {
      if (change === "policy") state.policy = "policy-2";
      else state.mode = "shadow";
    };
    await reconcileCoordinatorGoals(hostUrl, signal);
    const current = store.get(goal.id)!;
    assert.equal(current.state, "needs-human");
    assert.equal(current.items[0].state, "awaiting-result");
    assert.equal(current.items[0].evidence?.accepted, undefined);
  }
});

test("current goal judgments persist only correlated, current and verified results", async () => {
  const goal = awaitingGoal("current-goal");
  await reconcileCoordinatorGoals(hostUrl, signal);
  const current = store.get(goal.id)!;
  assert.equal(current.state, "completed");
  assert.equal(current.items[0].evidence?.accepted, true);
  assert.equal(current.items[0].evidence?.verified, true);
  assert.equal(state.goalJudgments, 1);
});

test("goal host-generation and result drift still fence acceptance despite a current policy", async () => {
  for (const change of ["generation", "result"]) {
    const goal = awaitingGoal(`source-${change}`);
    state.afterGoalJudgment = () => {
      if (change === "generation") state.generation++;
      else state.cards[0].outcomeEvidence!.text = "Changed after judgment";
    };
    await reconcileCoordinatorGoals(hostUrl, signal);
    let current = store.get(goal.id)!;
    assert.equal(current.state, "active");
    assert.equal(current.items[0].state, "awaiting-result");
    assert.equal(current.items[0].evidence?.accepted, undefined);
    current = store.update(current.id, current.revision, { state: "paused" });
    assert.equal(current.state, "paused");
  }
});
