import assert from "node:assert/strict";
import { test } from "node:test";

import {
  awaitAbortableBoundary,
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
