import assert from "node:assert/strict";
import test from "node:test";

import {
  isToolSpawnedWorker,
  isWorkerActive,
  mapWorkerChats,
  retainInactiveWorkers,
  workerRuntime,
  type WorkerChatSummary,
} from "./worker-activity.ts";

const toolWorker = {
  resource: "ahp-chat:/worker",
  title: "Inspect API routes",
  status: 8,
  activity: "Reading route handlers",
  origin: { kind: "tool", chat: "ahp-chat:/lead", toolCallId: "delegate-1" },
} as unknown as WorkerChatSummary;

test("tool-spawned in-progress chats are active workers", () => {
  assert.equal(isToolSpawnedWorker(toolWorker), true);
  assert.equal(isWorkerActive(toolWorker), true);
  assert.deepEqual(mapWorkerChats([toolWorker]), [{
    id: "ahp-chat:/worker",
    title: "Inspect API routes",
    runtime: "running",
    activity: "Reading route handlers",
    isActive: true,
    history: [],
  }]);
});

test("input-needed workers are visible but not counted as active", () => {
  const worker = { ...toolWorker, status: 24 };
  assert.equal(isWorkerActive(worker), false);
  assert.equal(workerRuntime(worker.status), "input-needed");
});

test("user and fork chats never appear as workers", () => {
  const userChat = {
    ...toolWorker,
    resource: "ahp-chat:/user",
    origin: { kind: "user" },
  } as unknown as WorkerChatSummary;
  assert.equal(isToolSpawnedWorker(userChat), false);
  assert.deepEqual(mapWorkerChats([toolWorker, userChat]).map((worker) => worker.id), [toolWorker.resource]);
});

test("workers pruned from the host catalog remain as inactive task history", () => {
  const current = mapWorkerChats([toolWorker]);
  current[0].usage = {
    inputTokens: 12_000,
    outputTokens: 800,
    cacheReadTokens: 10_000,
  };
  const retained = retainInactiveWorkers(current, []);
  assert.equal(retained[0].id, toolWorker.resource);
  assert.equal(retained[0].isActive, false);
  assert.equal(retained[0].runtime, "idle");
  assert.deepEqual(retained[0].usage, current[0].usage);
});

test("hidden workers are omitted and missing status remains unknown", () => {
  const unknown = { ...toolWorker, status: undefined };
  assert.equal(workerRuntime(undefined), "unknown");
  assert.equal(mapWorkerChats([unknown])[0].runtime, "unknown");
  assert.equal(isWorkerActive(unknown), false);
  assert.deepEqual(mapWorkerChats([{ ...toolWorker, interactivity: "hidden" as WorkerChatSummary["interactivity"] }]), []);
  assert.equal(mapWorkerChats([{ ...toolWorker, status: 72 as WorkerChatSummary["status"] }])[0].runtime, "idle");
});
