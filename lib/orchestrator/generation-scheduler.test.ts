import assert from "node:assert/strict";
import { test } from "node:test";

import { SerializedGenerationScheduler } from "./generation-scheduler.ts";

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("reconnect waits for the retired generation tick without sharing in-progress state", async () => {
  const scheduler = new SerializedGenerationScheduler();
  const firstStarted = deferred();
  const releaseFirst = deferred();
  const secondStarted = deferred();
  const releaseSecond = deferred();

  const first = scheduler.start({
    intervalMs: 60_000,
    async run() {
      firstStarted.resolve();
      await releaseFirst.promise;
    },
    onError: assert.fail,
  });
  await firstStarted.promise;

  const stopped = scheduler.stop(first);
  const second = scheduler.start({
    intervalMs: 60_000,
    async run() {
      secondStarted.resolve();
      await releaseSecond.promise;
    },
    onError: assert.fail,
  });

  await Promise.resolve();
  assert.equal(scheduler.isCurrent(first), false);
  assert.equal(scheduler.isCurrent(second), true);
  assert.equal(scheduler.isTickInProgress(second), false);

  releaseFirst.resolve();
  await stopped;
  await secondStarted.promise;
  assert.equal(scheduler.isTickInProgress(second), true);

  releaseSecond.resolve();
  await scheduler.stop(second);
});

test("reconnect waits for detached work owned by the retired generation", async () => {
  const scheduler = new SerializedGenerationScheduler();
  const firstTick = deferred();
  const detached = deferred();
  const replacementStarted = deferred();

  const first = scheduler.start({
    intervalMs: 60_000,
    async run(generation) {
      scheduler.track(generation, detached.promise);
      firstTick.resolve();
    },
    onError: assert.fail,
  });
  await firstTick.promise;

  const stopped = scheduler.stop(first);
  const replacement = scheduler.start({
    intervalMs: 60_000,
    async run() {
      replacementStarted.resolve();
    },
    onError: assert.fail,
  });
  await Promise.resolve();
  assert.equal(scheduler.isTickInProgress(replacement), false);

  detached.resolve();
  await stopped;
  await replacementStarted.promise;
  await scheduler.stop(replacement);
});

test("stop bounds a stalled nonmutating generation and allows a fresh generation to start", async () => {
  const scheduler = new SerializedGenerationScheduler();
  const started = deferred();
  const never = deferred();
  const replacementStarted = deferred();
  const first = scheduler.start({
    intervalMs: 60_000,
    drainTimeoutMs: 5,
    async run() {
      started.resolve();
      await never.promise;
    },
    onError: assert.fail,
  });
  await started.promise;
  const stopped = scheduler.stop(first);
  assert.equal(first.signal.aborted, true);
  assert.equal(scheduler.isCurrent(first), false);
  const second = scheduler.start({
    intervalMs: 60_000,
    async run() { replacementStarted.resolve(); },
    onError: assert.fail,
  });
  await stopped;
  await replacementStarted.promise;
  assert.equal(scheduler.isCurrent(second), true);
  never.resolve();
  await scheduler.stop(second);
});

test("event wakeups coalesce during a tick and never execute ticks concurrently", async () => {
  const scheduler = new SerializedGenerationScheduler();
  const started = deferred();
  const release = deferred();
  const rerun = deferred();
  let count = 0;
  let active = 0;
  let maxActive = 0;
  const generation = scheduler.start({
    intervalMs: 60_000,
    async run() {
      active++;
      maxActive = Math.max(maxActive, active);
      count++;
      if (count === 1) {
        started.resolve();
        await release.promise;
      } else {
        rerun.resolve();
      }
      active--;
    },
    onError: assert.fail,
  });
  await started.promise;
  for (let i = 0; i < 20; i++) scheduler.requestRun(generation);
  release.resolve();
  await rerun.promise;
  await scheduler.stop(generation);
  assert.equal(count, 2);
  assert.equal(maxActive, 1);
  scheduler.requestRun(generation);
  await Promise.resolve();
  assert.equal(count, 2);
});
