import assert from "node:assert/strict";
import test from "node:test";
import type { AhpClient } from "@microsoft/agent-host-protocol/client";

import { withOwnedClient } from "./owned-client.ts";
import { dispatchAndConfirm, MessageDispatchAmbiguousError } from "./dispatch-confirmation.ts";

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

test("cancellation closes only the client owned by the pending operation", async () => {
  const controller = new AbortController();
  const client = fakeClient(1);
  const other = fakeClient(2);
  let fail!: (error: Error) => void;
  let started!: () => void;
  const running = new Promise<void>((resolve) => { started = resolve; });
  client.shutdown = async () => {
    client.shutdownCalls++;
    fail(new Error("owned connection closed"));
  };
  const result = withOwnedClient(
    async () => client,
    async () => {
      started();
      return new Promise<void>((_, reject) => { fail = reject; });
    },
    () => assert.fail("cleanup should succeed"),
    controller.signal,
  );
  await running;
  controller.abort();
  await assert.rejects(result, /owned connection closed/);
  assert.equal(client.shutdownCalls, 1);
  assert.equal(other.shutdownCalls, 0);
});

test("pending dispatch cancellation preserves ambiguity through owned cleanup", async () => {
  const controller = new AbortController();
  const client = fakeClient(1);
  let started!: () => void;
  const running = new Promise<void>((resolve) => { started = resolve; });
  const result = withOwnedClient(
    async () => client,
    async () => dispatchAndConfirm({
      dispatch() { started(); },
      ping() { return new Promise<void>(() => {}); },
    } as unknown as Pick<AhpClient, "dispatch" | "ping">,
    "chat:1", { type: "test" } as never, "possibly delivered", controller.signal),
    () => assert.fail("cleanup should succeed"),
    controller.signal,
  );
  await running;
  controller.abort();
  await assert.rejects(result, MessageDispatchAmbiguousError);
  assert.equal(client.shutdownCalls, 1);
});

test("abort does not replace a mutation result already confirmed by the operation", async () => {
  const controller = new AbortController();
  const client = fakeClient(1);
  const result = await withOwnedClient(
    async () => client,
    async () => {
      controller.abort();
      return { confirmed: true };
    },
    () => assert.fail("cleanup should succeed"),
    controller.signal,
  );
  assert.deepEqual(result, { confirmed: true });
  assert.equal(client.shutdownCalls, 1);
});

test("shutdown and an uncooperative operation are bounded on cancellation", async () => {
  const controller = new AbortController();
  const errors: unknown[] = [];
  let started!: () => void;
  const running = new Promise<void>((resolve) => { started = resolve; });
  const result = withOwnedClient(
    async () => ({ shutdown: () => new Promise<void>(() => {}) }),
    async () => { started(); return new Promise<void>(() => {}); },
    (error) => errors.push(error),
    controller.signal,
  );
  await running;
  controller.abort();
  await assert.rejects(result, { name: "AbortError" });
  assert.equal(errors.length, 1);
});

test("a throwing cleanup reporter cannot replace the operation error", async () => {
  const operationError = new Error("original operation failure");
  await assert.rejects(withOwnedClient(
    async () => fakeClient(1, new Error("cleanup failure")),
    async () => { throw operationError; },
    () => { throw new Error("reporter failure"); },
  ), (error) => error === operationError);
});
