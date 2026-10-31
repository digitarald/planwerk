import assert from "node:assert/strict";
import { test } from "node:test";
import Database from "better-sqlite3";
import { CoordinatorGoalStore, ensureCoordinatorGoalsSchema } from "./coordinator-goals.ts";
import { ensureCoordinatorDeliveriesSchema, recordCoordinatorDelivery, getCoordinatorDelivery } from "./coordinator-deliveries.ts";

function fixture() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  ensureCoordinatorGoalsSchema(db);
  const store = new CoordinatorGoalStore(db);
  const goal = store.create({ id: "goal", objective: "Integrate API", acceptanceCriteria: "Integration works",
    hostUrl: "vscode-local://desktop", workspaceScope: ["/workspace"] });
  return { db, store, goal };
}
const item = (id: string, dependencies: { itemId: string; kind: "verified" | "result" }[] = []) => ({
  id, instructions: `Do ${id}`, acceptanceCriteria: `${id} works`, workingDirectory: "/workspace", dependencies,
});

test("goal commands are atomic, durable, idempotent and reject reused arguments", () => {
  const { db, store, goal } = fixture();
  const args = { action: "add_work", goalId: goal.id, revision: goal.revision };
  const apply = () => store.command("command", args, () => store.addItem(goal.id, goal.revision, item("a")));
  const first = apply();
  assert.equal(JSON.stringify(apply()), JSON.stringify(first));
  assert.equal(first.items.length, 1);
  assert.throws(() => store.command("command", { ...args, revision: 99 }, () => first), /different arguments/);
  const restored = new CoordinatorGoalStore(db).get(goal.id)!;
  assert.deepEqual(restored, first);
  assert.equal(restored.items[0].actionKey, "goal-work:v1:goal:a");
  db.close();
});

test("cross-goal edges and cycles roll back; edge kinds survive reload", () => {
  const { db, store, goal } = fixture();
  let value = store.addItem(goal.id, goal.revision, item("a"));
  value = store.addItem(goal.id, value.revision, item("b", [{ itemId: "a", kind: "verified" }]));
  assert.throws(() => store.setDependencies(goal.id, value.revision, "a", [{ itemId: "b", kind: "result" }]), /cycle/);
  assert.equal(store.get(goal.id)!.revision, value.revision);
  assert.deepEqual(store.get(goal.id)!.items[0].dependencies, []);
  assert.throws(() => store.addItem(goal.id, value.revision, item("c", [{ itemId: "foreign", kind: "result" }])), /belong/);
  assert.equal(store.get(goal.id)!.items.length, 2);
  assert.equal(store.get(goal.id)!.items[1].dependencies[0].kind, "verified");
  db.close();
});

test("lease fencing, expiry, pause and terminal states stop late effects", () => {
  const { db, store, goal } = fixture();
  let value = store.addItem(goal.id, goal.revision, item("a"));
  value = store.update(goal.id, value.revision, { state: "active" });
  const now = Date.now();
  assert.equal(store.claim(goal.id, value.revision, "owner", now, 100), true);
  assert.equal(store.claim(goal.id, value.revision, "other", now, 100), false);
  assert.equal(store.owns(goal.id, value.revision, "owner", now), true);
  assert.equal(store.claim(goal.id, value.revision, "other", now + 101, 100), true);
  assert.throws(() => store.saveItem(goal.id, value.revision, value.items[0], "owner"), /lease/);
  value = store.update(goal.id, value.revision, { state: "paused" });
  assert.equal(store.owns(goal.id, value.revision, "other"), false);
  value = store.update(goal.id, value.revision, { state: "cancelled" });
  assert.throws(() => store.update(goal.id, value.revision, { state: "active" }), /terminal/);
  db.close();
});

test("delivery identity is persisted before effects, including an uncorrelated queue ID", () => {
  const { db } = fixture();
  ensureCoordinatorDeliveriesSchema(db);
  recordCoordinatorDelivery(db, "action", { resource: "session" });
  assert.equal(getCoordinatorDelivery(db, "action")?.resource, "session");
  recordCoordinatorDelivery(db, "action", { resource: "session", chatUri: "chat", messageId: "queued-message", queued: true });
  assert.deepEqual(getCoordinatorDelivery(db, "action"), { resource: "session", chatUri: "chat", messageId: "queued-message", queued: true });
  db.close();
});

test("scope and actionable ordering apply before the display cap; active reconciliation has no display cap", () => {
  const { db, store, goal } = fixture();
  store.update(goal.id, goal.revision, { state: "active" });
  for (let index = 0; index < 105; index++) {
    const other = store.create({
      id: `other-${index}`, hostUrl: goal.hostUrl, workspaceScope: ["/other"],
      objective: "Other workspace", acceptanceCriteria: "Done",
    });
    store.update(other.id, other.revision, { state: "active" });
  }
  const terminal = store.create({ ...goal, id: "terminal" });
  store.update(terminal.id, terminal.revision, { state: "completed" });
  assert.deepEqual(store.list(goal.hostUrl, 1, ["/workspace"]).map((item) => item.id), [goal.id]);
  assert.equal(store.list(goal.hostUrl, 100, ["/other"]).length, 100);
  assert.equal(store.list(goal.hostUrl, 100, ["/missing"]).length, 0);
  const active = [...store.active(goal.hostUrl)];
  assert.equal(active.length, 106);
  for (const item of store.active(goal.hostUrl)) {
    store.update(item.id, item.revision, { summary: "Observed" });
  }
  assert.equal(store.get(goal.id)!.summary, "Observed");
  db.close();
});
