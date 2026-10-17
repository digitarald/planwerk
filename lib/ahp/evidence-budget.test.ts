import assert from "node:assert/strict";
import { test } from "node:test";
import { EvidenceCaptureBudget, EvidenceCaptureLimitError } from "./evidence-budget.ts";

test("capture limits count all decoded bytes and reject too many files", () => {
  const files = new EvidenceCaptureBudget({ maxFiles: 2, maxDecodedBytes: 10, timeoutMs: 1_000 });
  assert.throws(() => files.assertFileCount(3), (error) =>
    error instanceof EvidenceCaptureLimitError && error.detail === "file-limit");
  files.dispose();
  const bytes = new EvidenceCaptureBudget({ maxFiles: 2, maxDecodedBytes: 10, timeoutMs: 1_000 });
  bytes.consumeDecodedBytes(6);
  bytes.consumeDecodedBytes(4);
  assert.throws(() => bytes.consumeDecodedBytes(1), (error) =>
    error instanceof EvidenceCaptureLimitError && error.detail === "byte-limit");
  bytes.dispose();
});

test("the total deadline aborts a capture and disposal clears its timer", async () => {
  const budget = new EvidenceCaptureBudget({ maxFiles: 2, maxDecodedBytes: 10, timeoutMs: 10 });
  await new Promise<void>((resolve) => budget.signal.addEventListener("abort", () => resolve(), { once: true }));
  assert.throws(() => budget.assertCurrent(), (error) =>
    error instanceof EvidenceCaptureLimitError && error.detail === "deadline");
  budget.dispose();
  const disposed = new EvidenceCaptureBudget({ maxFiles: 2, maxDecodedBytes: 10, timeoutMs: 5 });
  disposed.dispose();
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(disposed.signal.aborted, false);
});

test("caller cancellation remains cancellation rather than an unsupported capture", () => {
  const controller = new AbortController();
  const budget = new EvidenceCaptureBudget(undefined, controller.signal);
  controller.abort("cancelled");
  assert.throws(() => budget.assertCurrent(), { name: "AbortError" });
  budget.dispose();
});

test("synchronous processing cannot commit after a deadline whose timer has not run", () => {
  const original = Date.now;
  let now = 1_000;
  Date.now = () => now;
  const budget = new EvidenceCaptureBudget({ maxFiles: 2, maxDecodedBytes: 10, timeoutMs: 10 });
  try {
    now += 11;
    assert.throws(() => budget.assertCurrent(), (error) =>
      error instanceof EvidenceCaptureLimitError && error.detail === "deadline");
  } finally {
    budget.dispose();
    Date.now = original;
  }
});
