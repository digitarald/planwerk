import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import {
  ConnectionError,
  ConnectionErrors,
  ErrorCodes,
  ResponseError,
} from "vscode-jsonrpc/node.js";

import {
  classifyCopilotFailure,
  CopilotRuntimeManager,
  CopilotRuntimeResetLimitError,
  isCopilotRuntimeInvalidatingFailure,
  type ManagedCopilotRuntimeClient,
} from "./sdk-runtime-manager.ts";
import { CopilotCleanupTimeoutError } from "./sdk-lifecycle.ts";

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
  cleanupTimeoutMs?: number;
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

test("SDK and application share JSON-RPC error constructor identities", () => {
  const require = createRequire(import.meta.url);
  const sdkRequire = createRequire(require.resolve("@github/copilot-sdk"));
  assert.equal(
    sdkRequire.resolve("vscode-jsonrpc/node.js"),
    require.resolve("vscode-jsonrpc/node.js"),
    "Update the direct vscode-jsonrpc pin with the SDK to preserve error classification.",
  );
});

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

test("JSON-RPC transport codes override message and application data", () => {
  for (const code of [
    ErrorCodes.MessageWriteError,
    ErrorCodes.MessageReadError,
    ErrorCodes.PendingResponseRejected,
    ErrorCodes.ConnectionInactive,
  ]) {
    const error = new ResponseError(code, "Session not found", {
      code: "workflow_not_found",
    });
    assert.equal(classifyCopilotFailure(error), "transport", `code ${code}`);
    assert.equal(isCopilotRuntimeInvalidatingFailure(error), true);
  }
});

test("domain and unknown RPC codes override transport-like messages and data", () => {
  for (const code of [
    ErrorCodes.ParseError,
    ErrorCodes.InvalidRequest,
    ErrorCodes.MethodNotFound,
    ErrorCodes.InvalidParams,
    ErrorCodes.InternalError,
    ErrorCodes.ServerNotInitialized,
    ErrorCodes.UnknownErrorCode,
    -32800,
    -32050,
    1,
  ]) {
    for (const data of [
      undefined,
      null,
      "ECONNRESET",
      42,
      [],
      { code: "workflow_not_found" },
      { code: "canvas_handler_error", message: "socket closed" },
      { code: "ECONNRESET" },
      { code: ErrorCodes.ConnectionInactive },
      { code: { code: ErrorCodes.MessageWriteError } },
      { unknown: true },
    ]) {
      const error = new ResponseError(
        code,
        "Cannot configure socket connection transport",
        data,
      );
      assert.equal(classifyCopilotFailure(error), "domain", `code ${code}`);
      assert.equal(isCopilotRuntimeInvalidatingFailure(error), false);
    }
  }
});

test("native JSON-RPC connection errors use their own code namespace", () => {
  for (const code of [ConnectionErrors.Closed, ConnectionErrors.Disposed]) {
    assert.equal(
      classifyCopilotFailure(new ConnectionError(code, "Request failed")),
      "transport",
    );
  }
  for (const code of [ConnectionErrors.AlreadyListening, 99]) {
    assert.equal(
      classifyCopilotFailure(new ConnectionError(code, "Connection failure")),
      "domain",
    );
  }
});

test("malformed and lookalike payloads do not acquire RPC code semantics", () => {
  for (const error of [
    undefined,
    null,
    1,
    {},
    { code: ErrorCodes.MessageWriteError, message: "Request failed" },
    { code: String(ErrorCodes.MessageWriteError), data: { code: "ECONNRESET" } },
    { code: ConnectionErrors.Closed, message: "Request failed" },
    { data: { code: ErrorCodes.ConnectionInactive } },
    Object.assign(new Error("Request failed"), { data: { code: "ECONNRESET" } }),
    Object.assign(new Error("Request failed"), { code: 1 }),
  ]) {
    assert.equal(classifyCopilotFailure(error), "domain");
  }
  for (const code of [NaN, Infinity, -32099.5, "-32099", undefined]) {
    const error = new ResponseError(
      code as number,
      "Connection closed",
      { code: "ECONNRESET" },
    );
    assert.equal(classifyCopilotFailure(error), "domain");
  }
});

test("native transport and unstructured SDK errors retain fallback classification", () => {
  for (const code of ["ECONNRESET", "ECONNREFUSED", "EPIPE", "ENOTCONN", "ETIMEDOUT"]) {
    assert.equal(
      classifyCopilotFailure(Object.assign(new Error("Request failed"), { code })),
      "transport",
    );
  }
  for (const message of [
    "The in-process runtime connection is closed.",
    "Failed to write a frame to the in-process runtime connection.",
    "Client not started",
    "runtime exited",
    "socket closed",
  ]) {
    assert.equal(classifyCopilotFailure(new Error(message)), "transport");
  }
});

test("CTO cleanup timeout takes precedence over RPC transport and domain codes", () => {
  for (const code of [ErrorCodes.MessageWriteError, ErrorCodes.InvalidParams]) {
    const error = Object.assign(new ResponseError(code, "socket closed"), {
      name: "CtoSessionCleanupTimeoutError",
    });
    assert.equal(classifyCopilotFailure(error), "runtime-invalidating");
  }
  assert.equal(
    classifyCopilotFailure(Object.assign(new Error("Request failed"), {
      code: "CTO_SESSION_CLEANUP_TIMEOUT",
    })),
    "runtime-invalidating",
  );
});

test("domain RPC failures do not retire a healthy leased runtime", async () => {
  const { clients, manager } = createHarness();
  const lease = await manager.acquireClient();
  const error = new ResponseError(
    ErrorCodes.InternalError,
    "Cannot configure socket connection",
    { code: "canvas_handler_error" },
  );

  if (isCopilotRuntimeInvalidatingFailure(error)) {
    await lease.invalidate(error);
  }
  await lease.release();

  assert.equal(await manager.getClient(), lease.client);
  assert.equal(lease.client.stopCalls, 0);
  assert.equal(manager.getHealth().healthy, true);
  assert.equal(manager.getHealth().restartCount, 0);
  assert.equal(clients.length, 1);
  await manager.shutdown();
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

test("runtime stop and force-stop deadlines unblock lease release and replacement", async (t) => {
  const keepAlive = setInterval(() => {}, 1_000);
  t.after(() => clearInterval(keepAlive));
  const { manager } = createHarness({ cleanupTimeoutMs: 5 });
  const retired = await manager.acquireClient();
  let rejectStop!: (error: Error) => void;
  retired.client.stop = () => {
    retired.client.stopCalls++;
    return new Promise<Error[]>((_resolve, reject) => { rejectStop = reject; });
  };
  retired.client.forceStop = () => {
    retired.client.forceStopCalls++;
    return new Promise<void>(() => {});
  };
  await retired.invalidate(new Error("retire generation"));
  const replacement = await manager.acquireClient();
  await assert.rejects(retired.release(), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors.map((failure) => failure.operation), ["stop", "force-stop"]);
    assert.ok(error.errors.every((failure) => failure instanceof CopilotCleanupTimeoutError));
    assert.ok(error.errors.every(isCopilotRuntimeInvalidatingFailure));
    return true;
  });
  await retired.release();
  assert.equal(retired.client.stopCalls, 1);
  assert.equal(retired.client.forceStopCalls, 1);
  rejectStop(new Error("late stop failure"));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(await manager.getClient(), replacement.client);
  assert.equal(await retired.invalidate(new Error("late cleanup failure")), false);
  assert.equal(replacement.client.stopCalls, 0);
  await replacement.release();
  await manager.shutdown();
});

test("shutdown deadlines preserve explicit failures and do not poison serialized startup", async (t) => {
  const keepAlive = setInterval(() => {}, 1_000);
  t.after(() => clearInterval(keepAlive));
  const { manager } = createHarness({ cleanupTimeoutMs: 5 });
  const client = await manager.getClient();
  client.stop = () => new Promise<Error[]>(() => {});
  await assert.rejects(manager.shutdown(), AggregateError);
  assert.equal(client.forceStopCalls, 1);
  assert.equal(manager.getHealth().state, "failed");
  const replacement = await manager.getClient();
  assert.notEqual(replacement, client);
  await manager.shutdown();
});

test("failed startup cleanup has bounded stop and force-stop and permits retry", async (t) => {
  const keepAlive = setInterval(() => {}, 1_000);
  t.after(() => clearInterval(keepAlive));
  const broken = new FakeClient(1);
  const startError = new Error("startup failed");
  broken.startError = startError;
  broken.stop = () => new Promise<Error[]>(() => {});
  broken.forceStop = () => new Promise<void>(() => {});
  const replacement = new FakeClient(2);
  let attempts = 0;
  const manager = new CopilotRuntimeManager({
    createClient: () => attempts++ === 0 ? broken : replacement,
    cleanupTimeoutMs: 5,
  });
  await assert.rejects(manager.getClient(), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.errors[0], startError);
    assert.ok(error.errors[1] instanceof AggregateError);
    assert.deepEqual(error.errors[1].errors.map((failure: CopilotCleanupTimeoutError) =>
      failure.operation), ["stop", "force-stop"]);
    return true;
  });
  assert.equal(await manager.getClient(), replacement);
  await manager.shutdown();
});

test("stale leases cannot invalidate a later generation of the same client object", async () => {
  const client = new FakeClient(1);
  const manager = new CopilotRuntimeManager({ createClient: () => client });
  const stale = await manager.acquireClient();
  await stale.release();
  await manager.shutdown();
  const replacement = await manager.acquireClient();
  assert.ok(replacement.generation > stale.generation);
  assert.equal(await stale.invalidate(new Error("late failure")), false);
  assert.equal(manager.getHealth().healthy, true);
  await replacement.invalidate(new Error("current failure"));
  await replacement.release();
  assert.equal(client.stopCalls, 2);
});
