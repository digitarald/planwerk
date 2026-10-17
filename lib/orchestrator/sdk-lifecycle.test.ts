import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CopilotCleanupTimeoutError,
  withSdkCleanupTimeout,
} from "./sdk-lifecycle.ts";

test("cleanup deadlines preserve confirmed results and synchronous failures", async () => {
  assert.equal(await withSdkCleanupTimeout(async () => "confirmed", "delete"), "confirmed");
  const error = new Error("synchronous SDK failure");
  await assert.rejects(
    withSdkCleanupTimeout(() => { throw error; }, "disconnect"),
    (caught) => caught === error,
  );
});

test("cleanup deadlines report the stalled stage and observe its late rejection", async (t) => {
  const keepAlive = setInterval(() => {}, 1_000);
  t.after(() => clearInterval(keepAlive));
  let reject!: (error: Error) => void;
  const operation = new Promise<void>((_resolve, rejectPromise) => {
    reject = rejectPromise;
  });
  await assert.rejects(
    withSdkCleanupTimeout(() => operation, "abort", { timeoutMs: 5 }),
    (error) => error instanceof CopilotCleanupTimeoutError &&
      error.operation === "abort" &&
      error.code === "COPILOT_SDK_CLEANUP_TIMEOUT",
  );
  reject(new Error("late SDK rejection"));
  await new Promise<void>((resolve) => setImmediate(resolve));
});

test("cleanup deadlines reject invalid configuration without dispatching", async () => {
  let dispatched = false;
  for (const timeoutMs of [0, -1, NaN, Infinity]) {
    await assert.rejects(
      withSdkCleanupTimeout(async () => { dispatched = true; }, "stop", { timeoutMs }),
      RangeError,
    );
  }
  assert.equal(dispatched, false);
});
