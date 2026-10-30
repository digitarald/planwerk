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

const state = { db: new Database(":memory:"), owned: true, generations: 0 };
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
              return {model:"test", briefing:{
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
const { projectCardToInbox } = await import("./service.ts");
const host = "ws://test";
const observed = "2026-09-22T00:00:00.000Z";
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
}
after(async () => {
  await settle();
  state.db.close();
  hooks.deregister();
  Reflect.deleteProperty(globalThis, key);
});

test("reconnect before question hydration preserves the same open request and generated briefing", async () => {
  reset();
  projectCardToInbox(host, card(), undefined, state.db, { sourceObserved: true });
  await settle();
  const original = listInboxItems(state.db).items[0];
  assert.equal(original.briefing.provenance.sessionTitle, "Deployment");
  assert.equal(original.title, "Generated choice");
  applyInboxAction(state.db, original.id, "read", null, null);
  applyInboxAction(state.db, original.id, "pin", null, null);
  const before = getInboxItemBySourceKey(state.db, original.sourceKey)!;
  projectCardToInbox(host, card(false), undefined, state.db);
  projectCardToInbox(host, card(), card(false), state.db, { sourceObserved: true });
  await settle();
  const current = listInboxItems(state.db).items[0];
  assert.equal(listInboxItems(state.db).total, 1);
  assert.equal(current.id, original.id);
  assert.equal(current.workflowState, "open");
  assert.equal(current.readState, "read");
  assert.equal(current.pinnedAt, before.pinnedAt);
  assert.equal(current.updatedAt, before.updatedAt);
  assert.equal(state.generations, 1);
});

test("a confirmed question recovers automatic resolution but not a human resolution or snooze", async () => {
  reset();
  projectCardToInbox(host, card(), undefined, state.db, { sourceObserved: true });
  await settle();
  const original = listInboxItems(state.db).items[0];
  resolveInboxSource(state.db, original.sourceKey);
  projectCardToInbox(host, card(), undefined, state.db, { sourceObserved: true });
  assert.equal(getInboxItemBySourceKey(state.db, original.sourceKey)?.workflowState, "open");
  applyInboxAction(state.db, original.id, "snooze", null, "2099-01-01T00:00:00Z");
  projectCardToInbox(host, card(), undefined, state.db, { sourceObserved: true });
  assert.equal(getInboxItemBySourceKey(state.db, original.sourceKey)?.workflowState, "dismissed");
  applyInboxAction(state.db, original.id, "resolve", null, null);
  projectCardToInbox(host, card(false), undefined, state.db);
  projectCardToInbox(host, card(), undefined, state.db, { sourceObserved: true });
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
  projectCardToInbox(host, card(), undefined, state.db, { sourceObserved: true });
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
  projectCardToInbox(host, { ...card(false), runtime: "idle" }, undefined, state.db, { sourceObserved: true });
  const current = getInboxItemBySourceKey(state.db, original.sourceKey)!;
  assert.equal(current.workflowState, "open");
  assert.equal(current.briefing.freshness.sourceObservedAt, undefined);
});
