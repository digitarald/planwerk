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
