import assert from "node:assert/strict";
import { test } from "node:test";

import { awaitAbortable, OperationAbortedError } from "../abort.ts";
import { coordinatorModeAllows, type CoordinatorMode } from "./coordinator-mode.ts";
import { OperationAdmission } from "./operation-admission.ts";
import {
  assertOperationCurrent,
  getOperationSignal,
  runOperationEffect,
  withOperationContext,
} from "./operation-context.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function harness() {
  const admission = new OperationAdmission();
  const controller = new AbortController();
  const lease = admission.acquire("host", "card")!;
  const authority: { mode: CoordinatorMode; scoped: boolean; source: string } = {
    mode: "coordinate", scoped: true, source: "revision-1",
  };
  const context = {
    signal: controller.signal,
    hostUrl: "host",
    cardId: "card",
    lease,
    isCurrent: (capability: Parameters<typeof coordinatorModeAllows>[1]) =>
      authority.scoped && authority.source === "revision-1" &&
      coordinatorModeAllows(authority.mode, capability),
  };
  return { admission, controller, lease, authority, context };
}

for (const change of ["downgrade", "disconnect", "scope", "source"] as const) {
  test(`${change} during assessment prevents new dispatch and phase writes`, async () => {
    const { authority, controller, context, lease } = harness();
    const assessment = deferred<void>();
    let dispatches = 0;
    let phaseWrites = 0;
    const operation = withOperationContext(context, async () => {
      await assessment.promise;
      await runOperationEffect("interact", async () => { dispatches++; });
      assertOperationCurrent("advance");
      phaseWrites++;
    });
    if (change === "downgrade") authority.mode = "verify";
    if (change === "disconnect") controller.abort();
    if (change === "scope") authority.scoped = false;
    if (change === "source") authority.source = "revision-2";
    assessment.resolve();
    await assert.rejects(operation, OperationAbortedError);
    assert.equal(dispatches, 0);
    assert.equal(phaseWrites, 0);
    lease.finish();
  });
}

test("cancelling nonmutating work releases admission, but its late continuation has no authority", async () => {
  const { admission, controller, context, lease } = harness();
  const assessment = deferred<void>();
  let writes = 0;
  const operation = withOperationContext(context, async () => {
    await assessment.promise;
    assertOperationCurrent("advance");
    writes++;
  });
  const waiter = awaitAbortable(() => operation, controller.signal);
  controller.abort();
  await assert.rejects(waiter, OperationAbortedError);
  lease.finish();
  const replacement = admission.acquire("host", "card");
  assert.ok(replacement);
  assessment.resolve();
  await assert.rejects(operation, OperationAbortedError);
  assert.equal(writes, 0);
  replacement.finish();
});

test("a raced-out uncertain remote write retains the same-session slot until its real settlement", async () => {
  const { admission, controller, context, lease } = harness();
  const remote = deferred<{ success: boolean }>();
  const operation = withOperationContext(context, () =>
    runOperationEffect("interact", () => remote.promise));
  const waiter = awaitAbortable(() => operation, controller.signal);
  controller.abort();
  await assert.rejects(waiter, OperationAbortedError);
  lease.finish();
  assert.equal(admission.acquire("host", "card"), null);
  const other = admission.acquire("host", "other");
  assert.ok(other);
  other.finish();

  remote.resolve({ success: true });
  assert.deepEqual(await operation, { success: true });
  const replacement = admission.acquire("host", "card");
  assert.ok(replacement);
  replacement.finish();
});

test("ambiguous dispatch stays quarantined even after the original promise rejects", async () => {
  const { admission, controller, context, lease } = harness();
  const remote = deferred<void>();
  const operation = withOperationContext(context, () =>
    runOperationEffect("interact", () => remote.promise));
  const waiter = awaitAbortable(() => operation, controller.signal);
  controller.abort();
  await assert.rejects(waiter, OperationAbortedError);
  lease.finish();
  remote.reject(new Error("Transport failed after dispatch"));
  await assert.rejects(operation, /Transport failed/);
  assert.equal(admission.isQuarantined("host", "card"), true);
  assert.equal(admission.acquire("host", "card"), null);
});

test("unconfirmed dispatch results also quarantine admission without claiming to undo the effect", async () => {
  const { admission, context, lease } = harness();
  const result = await withOperationContext(context, () =>
    runOperationEffect("interact", async () => ({ success: false })));
  assert.equal(result.success, false);
  lease.finish();
  assert.equal(admission.isQuarantined("host", "card"), true);
});

test("a late unconfirmed result cannot release the slot before ambiguity is classified", async () => {
  const { admission, controller, context, lease } = harness();
  const remote = deferred<{ success: boolean }>();
  const operation = withOperationContext(context, () =>
    runOperationEffect("interact", () => remote.promise));
  const waiter = awaitAbortable(() => operation, controller.signal);
  controller.abort();
  await assert.rejects(waiter, OperationAbortedError);
  lease.finish();
  remote.resolve({ success: false });
  await operation;
  assert.equal(admission.acquire("host", "card"), null);
  assert.equal(admission.isQuarantined("host", "card"), true);
});

test("proven pre-dispatch retryable results and already-stale inputs do not quarantine admission", async () => {
  for (const result of [{ success: false, disposition: "retryable" }, { success: false, stale: true }]) {
    const { admission, context, lease } = harness();
    await withOperationContext(context, () =>
      runOperationEffect("interact", async () => result));
    lease.finish();
    const replacement = admission.acquire("host", "card");
    assert.ok(replacement);
    replacement.finish();
  }
});

test("accepted effects survive cancellation, but cannot authorize subsequent phase commits", async () => {
  const { controller, context, lease } = harness();
  let accepted = false;
  await withOperationContext(context, async () => {
    await runOperationEffect("interact", async () => { accepted = true; });
    controller.abort();
    assert.throws(() => assertOperationCurrent("advance"), OperationAbortedError);
  });
  assert.equal(accepted, true);
  lease.finish();
});

test("admission capacity is bounded, applies backpressure, and returns only after real settlement", async () => {
  const admission = new OperationAdmission(1);
  const first = admission.acquire("host", "first")!;
  assert.equal(admission.acquire("other-host", "second"), null);
  const remote = deferred<void>();
  const pending = first.effect(() => remote.promise);
  first.finish();
  assert.equal(admission.acquire("other-host", "second"), null);
  remote.resolve();
  await pending;
  const second = admission.acquire("other-host", "second");
  assert.ok(second);
  second.finish();
});

test("quarantined leases count against capacity and never age out into a mutation retry", async () => {
  const admission = new OperationAdmission(1);
  const first = admission.acquire("host", "first")!;
  await first.effect(async () => ({ success: false }));
  first.finish();
  assert.equal(admission.acquire("host", "first"), null);
  assert.equal(admission.acquire("other-host", "second"), null);
});

test("admission rejects invalid capacities and finished leases cannot begin new writes", async () => {
  for (const capacity of [0, -1, 0.5, Infinity, NaN]) {
    assert.throws(() => new OperationAdmission(capacity), RangeError);
  }
  const admission = new OperationAdmission(1);
  const lease = admission.acquire("host", "card")!;
  lease.finish();
  let writes = 0;
  await assert.rejects(lease.effect(async () => { writes++; }), /no longer admits/);
  assert.equal(writes, 0);
});

test("async operation contexts remain isolated, restore the caller, and enforce admitted targets", async () => {
  const first = harness();
  const second = harness();
  const ready = deferred<void>();
  let secondWrites = 0;
  const firstTask = withOperationContext(first.context, async () => {
    await ready.promise;
    assert.equal(getOperationSignal(), first.controller.signal);
    assertOperationCurrent("interact");
  });
  const secondTask = withOperationContext(second.context, async () => {
    await ready.promise;
    assert.equal(getOperationSignal(), second.controller.signal);
    assert.throws(() => assertOperationCurrent("interact", { hostUrl: "wrong" }), OperationAbortedError);
    assert.throws(() => assertOperationCurrent("interact", { cardId: "wrong" }), OperationAbortedError);
    assertOperationCurrent("interact", { hostUrl: "host", cardId: "card" });
    await runOperationEffect("interact", async () => { secondWrites++; });
  });
  first.controller.abort();
  ready.resolve();
  await assert.rejects(firstTask, OperationAbortedError);
  await secondTask;
  assert.equal(secondWrites, 1);
  assert.equal(getOperationSignal(), undefined);
  assert.doesNotThrow(() => assertOperationCurrent("interact"));
  first.lease.finish();
  second.lease.finish();
});
