import assert from "node:assert/strict";
import { test } from "node:test";

import {
  classifyCopilotFailure,
  CopilotRuntimeManager,
  CopilotRuntimeResetLimitError,
  isCopilotRuntimeInvalidatingFailure,
  type ManagedCopilotRuntimeClient,
} from "./sdk-runtime-manager.ts";

class FakeClient implements ManagedCopilotRuntimeClient {
  readonly id: number;
  startCalls = 0;
  stopCalls = 0;
  forceStopCalls = 0;
  startError?: Error;
  stopErrors: Error[] = [];
  healthError?: Error;
  waitForStart?: Promise<void>;

  constructor(id: number) {
    this.id = id;
  }

  async start(): Promise<void> {
    this.startCalls++;
    await this.waitForStart;
    if (this.startError) throw this.startError;
  }

  async stop(): Promise<Error[]> {
    this.stopCalls++;
    return this.stopErrors;
  }

  async forceStop(): Promise<void> {
    this.forceStopCalls++;
  }

  async ping(message = "") {
    if (this.healthError) throw this.healthError;
    return {
      message,
      timestamp: "2026-09-10T00:00:00.000Z",
      protocolVersion: 2,
    };
  }

  async getStatus() {
    if (this.healthError) throw this.healthError;
    return { version: "1.0.13", protocolVersion: 2 };
  }
}

function createHarness(options: {
  maxResets?: number;
  resetWindowMs?: number;
  now?: () => number;
} = {}) {
  const clients: FakeClient[] = [];
  const manager = new CopilotRuntimeManager({
    createClient: () => {
      const client = new FakeClient(clients.length + 1);
      clients.push(client);
      return client;
    },
    ...options,
  });
  return { clients, manager };
}

test("serializes concurrent startup and shares one client", async () => {
  let releaseStart!: () => void;
  const startBlocked = new Promise<void>((resolve) => {
    releaseStart = resolve;
  });
  const client = new FakeClient(1);
  client.waitForStart = startBlocked;
  let createCalls = 0;
  const manager = new CopilotRuntimeManager({
    createClient: () => {
      createCalls++;
      return client;
    },
  });

  const first = manager.getClient();
  const second = manager.getClient();

  releaseStart();
  const [firstClient, secondClient] = await Promise.all([first, second]);

  assert.equal(createCalls, 1);
  assert.equal(firstClient, secondClient);
  assert.equal(client.startCalls, 1);
  assert.equal(manager.getHealth().state, "ready");
});

test("resets only the active client and starts one replacement", async () => {
  const { clients, manager } = createHarness();
  const first = await manager.getClient();
  const stale = new FakeClient(99);

  assert.equal(await manager.reset(stale, new Error("stale failure")), false);
  assert.equal(await manager.reset(first, new Error("runtime failed")), true);
  assert.equal(first.stopCalls, 1);

  const replacement = await manager.getClient();
  assert.notEqual(replacement, first);
  assert.equal(clients.length, 2);
  assert.equal(manager.getHealth().restartCount, 1);
});

test("invalidating a generation drains active operations before stopping it", async () => {
  const { clients, manager } = createHarness();
  const first = await manager.acquireClient();
  const concurrent = await manager.acquireClient();

  assert.equal(first.client, concurrent.client);
  assert.equal(
    await first.invalidate(Object.assign(new Error("socket closed"), {
      code: "ECONNRESET",
    })),
    true
  );
  assert.equal(first.client.stopCalls, 0);

  const replacement = await manager.acquireClient();
  assert.notEqual(replacement.client, first.client);
  await first.release();
  assert.equal(first.client.stopCalls, 0);
  await concurrent.release();
  assert.equal(first.client.stopCalls, 1);
  await replacement.release();
  assert.equal(clients.length, 2);
});

test("cleanup timeout retires its runtime generation before replacement", async () => {
  const { manager } = createHarness();
  const timedOut = await manager.acquireClient();
  const timeout = Object.assign(
    new Error("Copilot SDK session disconnect exceeded cleanup timeout"),
    {
      name: "CtoSessionCleanupTimeoutError",
      code: "CTO_SESSION_CLEANUP_TIMEOUT",
    },
  );

  assert.equal(isCopilotRuntimeInvalidatingFailure(timeout), true);
  assert.equal(await timedOut.invalidate(timeout), true);

  const replacement = await manager.acquireClient();
  assert.notEqual(replacement.client, timedOut.client);
  assert.ok(replacement.generation > timedOut.generation);
  assert.equal(await timedOut.invalidate(timeout), false);

  await timedOut.release();
  await replacement.release();
});

test("transport failures are distinct from domain and parsing failures", () => {
  assert.equal(
    classifyCopilotFailure(
      Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" })
    ),
    "transport"
  );
  assert.equal(
    classifyCopilotFailure(new SyntaxError("Unexpected token in model JSON")),
    "domain"
  );
  assert.equal(
    classifyCopilotFailure(new Error("Session not found")),
    "domain"
  );
  const cleanupTimeout = Object.assign(
    new Error("Copilot SDK session disconnect exceeded cleanup timeout"),
    {
      name: "CtoSessionCleanupTimeoutError",
      code: "CTO_SESSION_CLEANUP_TIMEOUT",
    },
  );
  assert.equal(
    classifyCopilotFailure(cleanupTimeout),
    "runtime-invalidating",
  );
  assert.equal(isCopilotRuntimeInvalidatingFailure(cleanupTimeout), true);
  assert.equal(
    isCopilotRuntimeInvalidatingFailure(
      new SyntaxError("Unexpected token in model JSON"),
    ),
    false,
  );
});

test("bounds repeated resets and permits recovery after the window", async () => {
  let now = 1_000;
  const { clients, manager } = createHarness({
    maxResets: 2,
    resetWindowMs: 100,
    now: () => now,
  });

  const first = await manager.getClient();
  await manager.reset(first, new Error("first failure"));
  const second = await manager.getClient();

  await assert.rejects(
    manager.reset(second, new Error("second failure")),
    CopilotRuntimeResetLimitError
  );
  await assert.rejects(manager.getClient(), CopilotRuntimeResetLimitError);
  assert.equal(clients.length, 2);

  now = 1_101;
  const recovered = await manager.getClient();
  assert.equal(recovered.id, 3);
  assert.equal(manager.getHealth().state, "ready");
});

test("reports runtime status without starting a stopped client", async () => {
  let now = 1_000;
  const { clients, manager } = createHarness({ now: () => now });

  assert.deepEqual(await manager.checkHealth(), {
    state: "stopped",
    healthy: false,
    restartCount: 0,
    startedAt: undefined,
    lastCheckedAt: undefined,
    blockedUntil: undefined,
    lastError: undefined,
    runtime: undefined,
  });
  assert.equal(clients.length, 0);

  await manager.getClient();
  now = 2_000;
  const health = await manager.checkHealth();
  assert.equal(health.healthy, true);
  assert.equal(health.runtime?.version, "1.0.13");
  assert.equal(health.runtime?.protocolVersion, 2);
  assert.equal(health.runtime?.pingTimestamp, "2026-09-10T00:00:00.000Z");
  assert.equal(health.lastCheckedAt, new Date(now).toISOString());
  assert.equal(manager.getHealth().runtime?.version, "1.0.13");
});

test("surfaces graceful cleanup errors after forcing cleanup", async () => {
  const { manager } = createHarness();
  const client = await manager.getClient();
  client.stopErrors = [new Error("session cleanup failed")];

  await assert.rejects(
    manager.shutdown(),
    (error: unknown) =>
      error instanceof AggregateError &&
      error.errors.some((item) => item instanceof Error && item.message === "session cleanup failed")
  );

  assert.equal(client.stopCalls, 1);
  assert.equal(client.forceStopCalls, 1);
  assert.equal(manager.getHealth().state, "failed");
  assert.match(manager.getHealth().lastError ?? "", /cleanup failed/);
});

test("deduplicates cleanup across repeated retired generations", async () => {
  const { clients, manager } = createHarness({ maxResets: 20 });

  for (let generation = 0; generation < 10; generation++) {
    const lease = await manager.acquireClient();
    assert.equal(
      await lease.invalidate(
        Object.assign(new Error("socket closed"), { code: "ECONNRESET" })
      ),
      true
    );
    await lease.release();
    await lease.release();
  }

  assert.equal(clients.length, 10);
  assert.deepEqual(
    clients.map((client) => client.stopCalls),
    Array.from({ length: 10 }, () => 1)
  );
});
