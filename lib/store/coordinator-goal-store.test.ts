import assert from "node:assert/strict";
import { after, test } from "node:test";
import { useCoordinatorGoalStore } from "./coordinator-goal-store.ts";
import type { CoordinatorGoal } from "../orchestrator/coordinator-goal-types.ts";

const originalFetch = globalThis.fetch;
after(() => { globalThis.fetch = originalFetch; });
const store = useCoordinatorGoalStore;
const goal: CoordinatorGoal = {
  id: "goal-a", hostUrl: "host-a", workspaceScope: ["/a"],
  objective: "Verify integration", acceptanceCriteria: "Tests pass",
  state: "active", revision: 1, items: [],
};
function deferred() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((done) => { resolve = done; });
  return { promise, resolve };
}
function response(goals: CoordinatorGoal[]) {
  return Response.json({ goals });
}

test("late hydration cannot replace the newly selected host and scope", async () => {
  const first = deferred();
  const second = deferred();
  let calls = 0;
  globalThis.fetch = async () => (++calls === 1 ? first.promise : second.promise);
  const oldRefresh = store.getState().refresh("host-a", ["/a"]);
  const newRefresh = store.getState().refresh("host-b", ["/b"]);
  const next = { ...goal, id: "goal-b", hostUrl: "host-b", workspaceScope: ["/b"] };
  second.resolve(response([next]));
  await newRefresh;
  first.resolve(response([goal]));
  await oldRefresh;
  assert.deepEqual(store.getState().goals, [next]);
  assert.equal(store.getState().scopeKey, JSON.stringify(["host-b", ["/b"]]));
  assert.equal(store.getState().loading, false);
});

for (const failed of [false, true]) {
  test(`late ${failed ? "failed" : "successful"} control cannot refresh or report errors in another scope`, async () => {
    const pending = deferred();
    let calls = 0;
    globalThis.fetch = async (_url, init) => {
      calls++;
      return init?.method === "POST" ? pending.promise : response([]);
    };
    await store.getState().refresh("host-a", ["/a"]);
    const oldControl = store.getState().control(goal, "pause", ["/a"]);
    await store.getState().refresh("host-b", ["/b"]);
    pending.resolve(failed ? Response.json({ error: "Old host error" }, { status: 409 }) : response([goal]));
    await oldControl;
    assert.equal(calls, 3);
    assert.deepEqual(store.getState().goals, []);
    assert.equal(store.getState().error, undefined);
    assert.equal(store.getState().pending, undefined);
    assert.equal(store.getState().scopeKey, JSON.stringify(["host-b", ["/b"]]));
  });
}
