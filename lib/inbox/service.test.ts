import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { after, test } from "node:test";
import Database from "better-sqlite3";
import { ensureInboxSchema } from "../db/inbox-schema.ts";
import {
  applyInboxAction, getInboxItemBySourceKey, listInboxItems,
  resolveInboxSource,
} from "../db/inbox-store.ts";
import type { KanbanCard } from "../types.ts";
import type { CoordinatorGoal } from "../orchestrator/coordinator-goal-types.ts";
import { serializeInboxItem } from "./contract.ts";
import { inboxEvents } from "./events.ts";
import { projectCardSnapshot, projectHeartbeatAction } from "./projector.ts";
import { AHPStatus } from "../ahp/types.ts";
import { INBOX_ITEM_KINDS } from "./types.ts";
import type { InboxStreamEvent } from "./types.ts";

const state: {
  db: Database.Database;
  owned: boolean;
  generations: number;
  staleDecision: boolean;
  generationWait?: Promise<void>;
} = { db: new Database(":memory:"), owned: true, generations: 0, staleDecision: false };
const key = "__inboxServiceTest";
Object.defineProperty(globalThis, key, { value: state, configurable: true });
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    const source = specifier === "../db/schema.ts"
      ? `export function getDb() { return globalThis["${key}"].db; }`
      : specifier === "../db/session-ownership.ts"
        ? `export function isSessionOwnedByHost() { return globalThis["${key}"].owned; }`
        : specifier === "./briefing-generator.ts"
          ? `export async function generateInboxBriefing() {
              globalThis["${key}"].generations++;
              await globalThis["${key}"].generationWait;
              return {model:"test", ...(globalThis["${key}"].staleDecision
                ? {decision:{policyKey:"obsolete",version:"inbox-test"}} : {}), briefing:{
                headline:"Generated choice", message:"Choose a target.", attention:"now",
                primaryAction:{intent:"reply",label:"Reply"}, secondaryActions:[]
              }};
            }`
          : undefined;
    return source
      ? { shortCircuit: true, url: `data:text/javascript,${encodeURIComponent(source)}` }
      : nextResolve(specifier, context);
  },
});
const {
  applyInboxProjection, projectCardToInbox, projectCoordinatorGoalToInbox,
  projectHeartbeatToInbox, projectArchivedSessionToInbox, projectRemovedSessionToInbox,
  reconcileInboxCatalogToInbox,
  projectLiveSnapshotToInbox,
} = await import("./service.ts");
const host = "ws://test";
const observed = "2026-09-22T00:00:00.000Z";
const liveInput = {
  observation: { type: "pending-input", requestId: "request", observedAt: observed },
} as const;
const liveCatalog = {
  observation: { type: "catalog", observedAt: observed },
} as const;
function card(pending = true): KanbanCard {
  return {
    id: "session", title: "Deployment", phase: "build", runtime: "input-needed",
    gateStatus: "pending", attention: "none", risk: "low", activity: "",
    additions: 0, deletions: 0, filesChanged: 0, planSteps: { total: 0, done: 0 },
    modifiedAt: Date.parse(observed), project: { name: "Project", path: "/project" },
    pendingInput: pending ? { requestId: "request", message: "Choose a target.", questions: [] } : undefined,
  };
}
async function settle() {
  for (let i = 0; i < 4; i++) await new Promise<void>((done) => setImmediate(done));
}
function reset() {
  state.db.close();
  state.db = new Database(":memory:");
  ensureInboxSchema(state.db);
  state.owned = true;
  state.generations = 0;
  state.staleDecision = false;
  state.generationWait = undefined;
}
after(async () => {
  await settle();
  state.db.close();
  hooks.deregister();
  Reflect.deleteProperty(globalThis, key);
});

test("goal decisions deduplicate and resolve when paused or replaced by a session handoff", () => {
  reset();
  const goal: CoordinatorGoal = { id: "goal", hostUrl: host, workspaceScope: ["/project"],
    objective: "Deliver a result", acceptanceCriteria: "Verified", state: "needs-human", revision: 1,
    summary: "Choose how to continue", items: [] };
  projectCoordinatorGoalToInbox(goal, state.db);
  projectCoordinatorGoalToInbox(goal, state.db);
  assert.equal(listInboxItems(state.db).total, 1);
  projectCoordinatorGoalToInbox({ ...goal, state: "paused" }, state.db);
  assert.equal(listInboxItems(state.db).total, 0);
  projectCoordinatorGoalToInbox(goal, state.db);
  projectCardToInbox(host, card(), undefined, state.db, liveInput);
  projectCoordinatorGoalToInbox({ ...goal, items: [{
    id: "work", goalId: goal.id, state: "awaiting-result", actionKey: "work",
    cardId: "session", workingDirectory: "/project", instructions: "Work", acceptanceCriteria: "Done", dependencies: [],
  }] }, state.db);
  assert.equal(listInboxItems(state.db).items.filter((item) => item.sourceKey.includes("coordinator-goal")).length, 0);
});

test("reconnect before question hydration preserves the same open request and generated briefing", async () => {
  reset();
  projectCardToInbox(host, card(), undefined, state.db, liveInput);
  await settle();
  const original = listInboxItems(state.db).items[0];
  assert.equal(original.briefing.provenance.sessionTitle, "Deployment");
  assert.equal(original.title, "Generated choice");
  applyInboxAction(state.db, original.id, "read", null, null);
  applyInboxAction(state.db, original.id, "pin", null, null);
  const before = getInboxItemBySourceKey(state.db, original.sourceKey)!;
  projectCardToInbox(host, card(false), undefined, state.db);
  projectCardToInbox(host, card(), card(false), state.db, liveInput);
  await settle();
  const current = listInboxItems(state.db).items[0];
  assert.equal(listInboxItems(state.db).total, 1);
  assert.equal(current.id, original.id);
  assert.equal(current.workflowState, "open");
  assert.equal(current.readState, "read");
  assert.equal(current.pinnedAt, before.pinnedAt);
  assert.equal(current.updatedAt, before.updatedAt);
  assert.equal(state.generations, 1);
  const events: InboxStreamEvent[] = [];
  const unsubscribe = inboxEvents.subscribe((event) => events.push(event));
  try {
    projectCardToInbox(host, card(), undefined, state.db, liveInput);
    await settle();
    assert.deepEqual(events, []);
    assert.equal(state.generations, 1);
  } finally { unsubscribe(); }
});

test("a confirmed question recovers automatic resolution but not a human resolution or snooze", async () => {
  reset();
  projectCardToInbox(host, card(), undefined, state.db, liveInput);
  await settle();
  const original = listInboxItems(state.db).items[0];
  resolveInboxSource(state.db, original.sourceKey);
  projectCardToInbox(host, card(), undefined, state.db);
  assert.equal(getInboxItemBySourceKey(state.db, original.sourceKey)?.workflowState, "resolved");
  projectCardToInbox(host, card(), undefined, state.db, liveInput);
  assert.equal(getInboxItemBySourceKey(state.db, original.sourceKey)?.workflowState, "open");
  applyInboxAction(state.db, original.id, "snooze", null, "2099-01-01T00:00:00Z");
  projectCardToInbox(host, card(), undefined, state.db, liveInput);
  assert.equal(getInboxItemBySourceKey(state.db, original.sourceKey)?.workflowState, "dismissed");
  applyInboxAction(state.db, original.id, "resolve", null, null);
  projectCardToInbox(host, card(false), undefined, state.db);
  projectCardToInbox(host, card(), undefined, state.db, liveInput);
  assert.equal(listInboxItems(state.db).total, 0);
  assert.equal(getInboxItemBySourceKey(state.db, original.sourceKey)?.workflowState, "resolved");
  await settle();
});

test("unavailable question notice is replaced once, never synthesized, and explicit clears resolve it", async () => {
  reset();
  projectCardToInbox(host, card(false), undefined, state.db);
  projectCardToInbox(host, card(false), undefined, state.db);
  const notice = listInboxItems(state.db).items[0];
  assert.equal(listInboxItems(state.db).total, 1);
  assert.equal(notice.briefing.recommendedAction?.intent, "open-session");
  assert.equal(notice.briefing.freshness.sourceObservedAt, undefined);
  assert.equal(state.generations, 0);
  projectCardToInbox(host, card(), undefined, state.db, liveInput);
  await settle();
  assert.equal(listInboxItems(state.db).total, 1);
  assert.notEqual(listInboxItems(state.db).items[0].id, notice.id);
  projectCardToInbox(host, card(false), undefined, state.db, { pendingInputCleared: true });
  assert.equal(listInboxItems(state.db).total, 0);
});

test("cached reprojection cannot revalidate source facts and quarantined sessions cannot mutate inbox", async () => {
  reset();
  projectCardToInbox(host, card(), undefined, state.db);
  await settle();
  const original = listInboxItems(state.db).items[0];
  assert.equal(original.briefing.freshness.sourceObservedAt, undefined);
  state.owned = false;
  projectCardToInbox(host, { ...card(false), runtime: "idle" }, undefined, state.db, liveCatalog);
  const current = getInboxItemBySourceKey(state.db, original.sourceKey)!;
  assert.equal(current.workflowState, "open");
  assert.equal(current.briefing.freshness.sourceObservedAt, undefined);
});

test("live card observations repair heartbeat identity without revalidating its result", () => {
  reset();
  const [mutation] = applyInboxProjection(host, projectHeartbeatAction({
    type: "gate-completed", cardId: "session", gateType: "lint", status: "failed",
  }, undefined, { hostUrl: host, now: observed }), state.db);
  projectCardToInbox(host, { ...card(false), runtime: "idle" }, undefined, state.db, liveCatalog);
  const current = getInboxItemBySourceKey(state.db, mutation.item.sourceKey)!;
  assert.equal(current.briefing.provenance.sessionTitle, "Deployment");
  assert.equal(current.briefing.freshness.sourceObservedAt, observed);
});

test("archive and removal events retire heartbeat blockers immediately and notify connected clients", async () => {
  for (const archived of [true, false]) {
    reset();
    const events: InboxStreamEvent[] = [];
    const unsubscribe = inboxEvents.subscribe((event) => events.push(event));
    try {
      projectHeartbeatToInbox(host, {
        type: "gate-completed", cardId: "session", gateType: "lint", status: "failed",
      }, card());
      projectHeartbeatToInbox(host, {
        type: "plan-review-failed", cardId: "session", reason: "Plan evidence missing",
      }, card());
      const notices = listInboxItems(state.db).items;
      assert.equal(notices.length, 2);
      if (archived) {
        projectArchivedSessionToInbox(host, {
          resource: "session", title: "Deployment", status: 97, provider: "test",
          createdAt: observed, modifiedAt: observed,
        });
      } else {
        projectRemovedSessionToInbox(host, "session");
      }
      await settle();
      for (const item of notices) {
        assert.equal(getInboxItemBySourceKey(state.db, item.sourceKey)?.workflowState, "resolved");
        assert.ok(events.some((event) => event.type === "inboxRemoved"
          && event.itemId === item.id && event.hostUrl === host));
      }
    } finally { unsubscribe(); }
  }
});

test("live archive and reconnect use the same retirement policy; removal and disabled sources retire every linked kind", async () => {
  for (const mode of ["archive", "reconnect", "missing", "disabled"] as const) {
    reset();
    const [operation] = projectHeartbeatAction({
      type: "gate-completed", cardId: "session", gateType: "lint", status: "failed",
    }, card(), { hostUrl: host, now: observed });
    assert.ok(operation.type === "upsert");
    const notices = applyInboxProjection(host, INBOX_ITEM_KINDS.map((kind) => ({
      type: "upsert",
      item: {
        ...operation.item,
        kind,
        sourceKey: kind === "completion"
          ? `session:session:completion:modified:${Date.parse(observed)}` : `notice:${kind}`,
      },
    })), state.db).map((mutation) => mutation.item);
    const session = {
      resource: "session", title: "Deployment", status: AHPStatus.Idle | AHPStatus.IsArchived,
      provider: "test", createdAt: observed, modifiedAt: observed,
    };
    if (mode === "archive") projectArchivedSessionToInbox(host, session);
    else if (mode === "missing") projectRemovedSessionToInbox(host, session.resource);
    else reconcileInboxCatalogToInbox(host, [{ session, enabled: mode !== "disabled" }]);
    await settle();
    for (const notice of notices) {
      const current = getInboxItemBySourceKey(state.db, notice.sourceKey)!;
      const retained = (mode === "archive" || mode === "reconnect")
        && ["completion", "conflict", "coordinator-action"].includes(notice.kind);
      assert.equal(current.workflowState, retained ? "open" : "resolved", `${mode}:${notice.kind}`);
      if (notice.kind === "gate-failure" || notice.kind === "review-escalation") {
        assert.equal(current.briefing.freshness.sourceObservedAt, observed);
      }
    }
    assert.equal(state.db.prepare("SELECT count(*) FROM inbox_item_actions").pluck().get(), 0);
  }
});

test("metadata repair and retirement publish only the final committed state", async () => {
  for (const mode of ["card", "catalog", "archive"] as const) {
    reset();
    projectCardToInbox(host, card(), undefined, state.db, liveInput);
    await settle();
    const original = listInboxItems(state.db).items[0];
    const events: Array<{ event: InboxStreamEvent; inTransaction: boolean; title?: string; workflow?: string }> = [];
    const unsubscribe = inboxEvents.subscribe((event) => {
      const current = getInboxItemBySourceKey(state.db, original.sourceKey);
      events.push({
        event, inTransaction: state.db.inTransaction,
        title: current?.briefing.provenance.sessionTitle, workflow: current?.workflowState,
      });
    });
    try {
      const session = {
        resource: "session", title: "Renamed", status: AHPStatus.Idle | AHPStatus.IsArchived,
        provider: "test", createdAt: observed, modifiedAt: observed,
      };
      if (mode === "card") {
        projectCardToInbox(host, { ...card(false), title: "Renamed", runtime: "idle" }, undefined, state.db, liveCatalog);
      } else if (mode === "archive") projectArchivedSessionToInbox(host, session);
      else reconcileInboxCatalogToInbox(host, [{ session, enabled: true }]);
      await settle();
      const removed = events.filter(({ event }) => event.type === "inboxRemoved"
        ? event.itemId === original.id : event.item.id === original.id);
      assert.deepEqual(removed, [{
        event: { type: "inboxRemoved", itemId: original.id, workflowState: "resolved", hostUrl: host },
        inTransaction: false, title: "Renamed", workflow: "resolved",
      }], mode);
    } finally { unsubscribe(); }
  }
});

test("failed projection rolls back metadata repair without publishing or scheduling synthesis", () => {
  reset();
  const [original] = applyInboxProjection(host, projectHeartbeatAction({
    type: "gate-completed", cardId: "session", gateType: "lint", status: "failed",
  }, undefined, { hostUrl: host, now: observed }), state.db);
  const events: InboxStreamEvent[] = [];
  const unsubscribe = inboxEvents.subscribe((event) => events.push(event));
  state.db.exec(`
    CREATE TRIGGER reject_runtime_error BEFORE INSERT ON inbox_items
    WHEN NEW.kind = 'runtime-error'
    BEGIN SELECT RAISE(ABORT, 'projection rejected'); END;
  `);
  try {
    assert.throws(() => projectCardToInbox(host, {
      ...card(false), runtime: "error", activity: "Failed",
    }, undefined, state.db, liveCatalog), /projection rejected/);
    assert.deepEqual(getInboxItemBySourceKey(state.db, original.item.sourceKey), original.item);
    assert.deepEqual(events, []);
    assert.equal(state.generations, 0);
    assert.equal(state.db.inTransaction, false);
  } finally { unsubscribe(); }
});

test("reconnect retires a resumed completion without publishing its intermediate catalog refresh", () => {
  reset();
  const [completion] = applyInboxProjection(host, projectCardSnapshot({
    ...card(false), runtime: "idle", lastAgentMessage: "Result",
  }, { ...card(false), runtime: "running" }, { hostUrl: host, now: observed }), state.db);
  assert.equal(completion.item.kind, "completion");
  const events: InboxStreamEvent[] = [];
  const unsubscribe = inboxEvents.subscribe((event) => events.push(event));
  try {
    projectLiveSnapshotToInbox(host, [{
      session: {
        resource: "session", title: "Renamed", status: AHPStatus.InProgress,
        provider: "test", createdAt: observed, modifiedAt: observed,
      },
      enabled: true,
    }], [{ ...card(false), title: "Renamed", runtime: "running" }], state.db);
    assert.deepEqual(events, [{
      type: "inboxRemoved", itemId: completion.item.id, workflowState: "resolved", hostUrl: host,
    }]);
    const current = getInboxItemBySourceKey(state.db, completion.item.sourceKey)!;
    assert.equal(current.workflowState, "resolved");
    assert.equal(current.briefing.provenance.sessionTitle, "Renamed");
    assert.equal(state.generations, 0);
  } finally { unsubscribe(); }
});

test("late synthesis cannot republish a retired notice", async () => {
  reset();
  let release = () => {};
  state.generationWait = new Promise<void>((resolve) => { release = resolve; });
  const events: InboxStreamEvent[] = [];
  const unsubscribe = inboxEvents.subscribe((event) => events.push(event));
  try {
    projectHeartbeatToInbox(host, {
      type: "gate-completed", cardId: "session", gateType: "lint", status: "failed",
    }, card());
    const original = listInboxItems(state.db).items[0];
    projectRemovedSessionToInbox(host, "session");
    const retiredEventCount = events.length;
    release();
    await settle();
    assert.equal(getInboxItemBySourceKey(state.db, original.sourceKey)?.workflowState, "resolved");
    assert.equal(getInboxItemBySourceKey(state.db, original.sourceKey)?.briefing.synthesis?.status, "pending");
    assert.equal(events.length, retiredEventCount);
  } finally {
    release();
    await settle();
    unsubscribe();
  }
});

test("a stale inbox decision cannot commit generated presentation or replace deterministic actions", async () => {
  reset();
  state.staleDecision = true;
  projectCardToInbox(host, card(), undefined, state.db, liveInput);
  await settle();
  const current = listInboxItems(state.db).items[0];
  assert.notEqual(current.title, "Generated choice");
  assert.equal(current.briefing.synthesis?.status, "failed");
  assert.equal(serializeInboxItem(current).briefing.defaultAction.kind, "reply");
});
