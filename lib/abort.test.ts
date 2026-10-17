import assert from "node:assert/strict";
import { test } from "node:test";

import {
  awaitAbortableBoundary,
  awaitAbortable,
  awaitWithTimeout,
  throwIfAborted,
} from "./abort.ts";

test("cancellation during a state await prevents message dispatch", async () => {
  const controller = new AbortController();
  let resolveState!: () => void;
  const state = new Promise<void>((resolve) => {
    resolveState = resolve;
  });

  let dispatches = 0;
  const operation = (async () => {
    await awaitAbortableBoundary(() => state, controller.signal);
    throwIfAborted(controller.signal);
    dispatches++;
  })();

  controller.abort();
  resolveState();

  await assert.rejects(
    operation,
    (error: unknown) => error instanceof Error && error.name === "AbortError",
  );
  assert.equal(dispatches, 0);
});

test("cancellation during input-state await prevents answer dispatch", async () => {
  const controller = new AbortController();
  let resolveState!: () => void;
  const state = new Promise<void>((resolve) => {
    resolveState = resolve;
  });
  let answers = 0;
  const operation = (async () => {
    await awaitAbortableBoundary(() => state, controller.signal);
    throwIfAborted(controller.signal);
    answers++;
  })();

  controller.abort();
  resolveState();

  await assert.rejects(
    operation,
    (error: unknown) => error instanceof Error && error.name === "AbortError",
  );
  assert.equal(answers, 0);
});

test("abort stops a pending await and observes a late rejection", async () => {
  const controller = new AbortController();
  let fail!: (error: Error) => void;
  const pending = new Promise<void>((_, reject) => { fail = reject; });
  const waiting = awaitAbortable(() => pending, controller.signal);
  controller.abort();
  await assert.rejects(waiting, { name: "AbortError" });
  fail(new Error("late failure"));
  await new Promise<void>((resolve) => setImmediate(resolve));
});

test("timeout bounds cleanup and observes a late rejection", async () => {
  let fail!: (error: Error) => void;
  const pending = new Promise<void>((_, reject) => { fail = reject; });
  await assert.rejects(awaitWithTimeout(() => pending, 1, "cleanup timeout"), /cleanup timeout/);
  fail(new Error("late cleanup failure"));
  await new Promise<void>((resolve) => setImmediate(resolve));
});
