import assert from "node:assert/strict";
import test from "node:test";

import { withOwnedClient } from "./owned-client.ts";

interface FakeClient {
  id: number;
  shutdownCalls: number;
  shutdownError?: Error;
  shutdown(): Promise<void>;
}

function fakeClient(id: number, shutdownError?: Error): FakeClient {
  return {
    id,
    shutdownCalls: 0,
    shutdownError,
    async shutdown() {
      this.shutdownCalls++;
      if (this.shutdownError) throw this.shutdownError;
    },
  };
}

test("owns and shuts down one client for a successful operation", async () => {
  const client = fakeClient(1);
  const result = await withOwnedClient(
    async () => client,
    async (owned) => owned.id,
    () => assert.fail("cleanup should succeed"),
  );

  assert.equal(result, 1);
  assert.equal(client.shutdownCalls, 1);
});

test("preserves an operation error and reports a cleanup error", async () => {
  const operationError = new Error("operation failed");
  const cleanupError = new Error("shutdown failed");
  const client = fakeClient(1, cleanupError);
  const cleanupErrors: unknown[] = [];

  await assert.rejects(
    withOwnedClient(
      async () => client,
      async () => {
        throw operationError;
      },
      (error) => cleanupErrors.push(error),
    ),
    operationError,
  );

  assert.equal(client.shutdownCalls, 1);
  assert.deepEqual(cleanupErrors, [cleanupError]);
});

test("preserves a confirmed result and separately reports cleanup failure", async () => {
  const cleanupError = new Error("shutdown failed");
  const client = fakeClient(1, cleanupError);
  const cleanupErrors: unknown[] = [];

  const result = await withOwnedClient(
    async () => client,
    async () => ({ sessionId: "created-1", chatUri: "chat-1", turnId: "turn-1" }),
    (error) => cleanupErrors.push(error),
  );
  assert.deepEqual(result, {
    sessionId: "created-1",
    chatUri: "chat-1",
    turnId: "turn-1",
  });
  assert.deepEqual(cleanupErrors, [cleanupError]);
  assert.equal(client.shutdownCalls, 1);
});

test("concurrent operations own distinct clients", async () => {
  const clients: FakeClient[] = [];
  let nextId = 0;
  let releaseFirst!: () => void;
  const firstBlocked = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });

  const create = async () => {
    const client = fakeClient(++nextId);
    clients.push(client);
    return client;
  };

  const first = withOwnedClient(
    create,
    async (client) => {
      await firstBlocked;
      return client.id;
    },
    () => assert.fail("cleanup should succeed"),
  );
  const second = withOwnedClient(
    create,
    async (client) => client.id,
    () => assert.fail("cleanup should succeed"),
  );

  assert.equal(await second, 2);
  assert.equal(clients[0]?.shutdownCalls, 0);
  assert.equal(clients[1]?.shutdownCalls, 1);

  releaseFirst();
  assert.equal(await first, 1);
  assert.deepEqual(clients.map((client) => client.shutdownCalls), [1, 1]);
});

test("cancellation during connection skips the operation and still shuts down the client", async () => {
  const client = fakeClient(1);
  const controller = new AbortController();
  let finishConnection!: () => void;
  const connection = new Promise<void>((resolve) => {
    finishConnection = resolve;
  });
  let operations = 0;

  const result = withOwnedClient(
    async () => {
      await connection;
      return client;
    },
    async () => {
      operations++;
    },
    () => assert.fail("cleanup should succeed"),
    controller.signal,
  );

  controller.abort();
  finishConnection();

  await assert.rejects(
    result,
    (error: unknown) => error instanceof Error && error.name === "AbortError",
  );
  assert.equal(operations, 0);
  assert.equal(client.shutdownCalls, 1);
});
