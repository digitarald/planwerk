import assert from "node:assert/strict";
import { test } from "node:test";

import {
  disconnectCopilotSession,
  disposeOneShotSession,
  invalidateRuntimeForCleanupFailure,
  releaseRuntimeLease,
} from "./copilot-session.ts";
import { CopilotCleanupTimeoutError } from "./sdk-lifecycle.ts";

function createSession(calls: string[], overrides: {
  deleteSession?: () => Promise<void>;
  abort?: () => Promise<void>;
  disconnect?: () => Promise<void>;
} = {}) {
  const client = {
    deleteSession: async () => {
      calls.push("delete");
      await overrides.deleteSession?.();
    },
  };
  const session = {
    sessionId: "session-1",
    abort: async () => {
      calls.push("abort");
      await overrides.abort?.();
    },
    disconnect: async () => {
      calls.push("disconnect");
      await overrides.disconnect?.();
    },
  };
  return { client, session };
}

test("disposeOneShotSession deletes a completed session", async () => {
  const calls: string[] = [];
  const { client, session } = createSession(calls);

  const report = await disposeOneShotSession(
    client,
    session,
    false,
    "[test]",
  );

  assert.deepEqual(calls, ["delete"]);
  assert.deepEqual(report.failures, []);
});

test("disposeOneShotSession aborts in-flight work before deletion", async () => {
  const calls: string[] = [];
  const { client, session } = createSession(calls);

  const report = await disposeOneShotSession(
    client,
    session,
    true,
    "[test]",
  );

  assert.deepEqual(calls, ["abort", "delete"]);
  assert.deepEqual(report.failures, []);
});

test("disposeOneShotSession disconnects when deletion fails", async () => {
  const calls: string[] = [];
  const { client, session } = createSession(calls, {
    deleteSession: async () => {
      throw new Error("delete failed");
    },
  });
  const warnings: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(args);

  try {
    const report = await disposeOneShotSession(
      client,
      session,
      false,
      "[test]",
    );
    assert.equal(report.failures.length, 1);
    assert.equal(report.failures[0].operation, "delete");
  } finally {
    console.warn = originalWarn;
  }

  assert.deepEqual(calls, ["delete", "disconnect"]);
  assert.equal(warnings.length, 1);
  assert.match(String(warnings[0][0]), /Failed to delete/);
});

test("cleanup transport failures invalidate the owning runtime generation", async () => {
  const calls: string[] = [];
  const transportError = Object.assign(new Error("socket closed"), {
    code: "ECONNRESET",
  });
  const { client, session } = createSession(calls, {
    deleteSession: async () => {
      throw transportError;
    },
  });
  const warnings: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(args);
  let invalidatedWith: unknown;

  try {
    const report = await disposeOneShotSession(
      client,
      session,
      false,
      "[test]",
    );
    const invalidated = await invalidateRuntimeForCleanupFailure(
      {
        client: {},
        generation: 1,
        invalidate: async (reason) => {
          invalidatedWith = reason;
          return true;
        },
        release: async () => {},
      },
      report,
      "[test]",
    );
    assert.equal(invalidated, true);
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(invalidatedWith, transportError);
  assert.deepEqual(calls, ["delete", "disconnect"]);
});

test("domain cleanup failures are reported without invalidating the runtime", async () => {
  const calls: string[] = [];
  const domainError = new Error("session already deleted");
  const { client, session } = createSession(calls, {
    deleteSession: async () => {
      throw domainError;
    },
  });
  const originalWarn = console.warn;
  console.warn = () => {};
  let invalidations = 0;

  try {
    const report = await disposeOneShotSession(
      client,
      session,
      false,
      "[test]",
    );
    assert.equal(report.failures[0].error, domainError);
    assert.equal(
      await invalidateRuntimeForCleanupFailure(
        {
          client: {},
          generation: 1,
          invalidate: async () => {
            invalidations++;
            return true;
          },
          release: async () => {},
        },
        report,
        "[test]",
      ),
      false,
    );
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(invalidations, 0);
  assert.deepEqual(calls, ["delete", "disconnect"]);
});

test("cleanup timeout invalidates the runtime despite being non-transport", async () => {
  const cleanupTimeout = Object.assign(
    new Error("Copilot SDK session disconnect exceeded cleanup timeout"),
    {
      name: "CtoSessionCleanupTimeoutError",
      code: "CTO_SESSION_CLEANUP_TIMEOUT",
    },
  );
  let invalidatedWith: unknown;

  assert.equal(
    await invalidateRuntimeForCleanupFailure(
      {
        client: {},
        generation: 1,
        invalidate: async (reason) => {
          invalidatedWith = reason;
          return true;
        },
        release: async () => {},
      },
      {
        failures: [{ operation: "disconnect", error: cleanupTimeout }],
      },
      "[test]",
    ),
    true,
  );
  assert.equal(invalidatedWith, cleanupTimeout);
});

test("runtime lease cleanup failure is surfaced without replacing a domain result", async () => {
  const cleanupError = new Error("runtime stop failed");
  const warnings: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(args);

  try {
    const result = { level: "low" };
    const reported = await releaseRuntimeLease(
      {
        release: async () => {
          throw cleanupError;
        },
      },
      "[test]",
    );
    assert.equal(reported, cleanupError);
    assert.deepEqual(result, { level: "low" });
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(warnings.length, 1);
  assert.match(String(warnings[0][0]), /Failed to release/);
});

test("one-shot cleanup bounds every stalled stage and still attempts fallback", async (t) => {
  const keepAlive = setInterval(() => {}, 1_000);
  t.after(() => clearInterval(keepAlive));
  t.mock.method(console, "warn", () => {});
  const calls: string[] = [];
  let finishAbort!: () => void;
  const pendingAbort = new Promise<void>((resolve) => { finishAbort = resolve; });
  const { client, session } = createSession(calls, {
    abort: () => pendingAbort,
    deleteSession: () => new Promise(() => {}),
    disconnect: () => new Promise(() => {}),
  });

  const report = await disposeOneShotSession(
    client, session, true, "[test]", { timeoutMs: 5 },
  );
  assert.deepEqual(calls, ["abort", "delete", "disconnect"]);
  assert.deepEqual(report.failures.map(({ operation }) => operation), [
    "abort", "delete", "disconnect",
  ]);
  assert.ok(report.failures.every(({ error }) => error instanceof CopilotCleanupTimeoutError));
  let reason: unknown;
  assert.equal(await invalidateRuntimeForCleanupFailure({
    client: {},
    generation: 1,
    invalidate: async (error) => { reason = error; return true; },
    release: async () => {},
  }, report, "[test]"), true);
  assert.equal(reason, report.failures[0].error);

  finishAbort();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ["abort", "delete", "disconnect"]);
});

test("disconnect proceeds after a stalled abort without claiming confirmed cleanup", async (t) => {
  const keepAlive = setInterval(() => {}, 1_000);
  t.after(() => clearInterval(keepAlive));
  t.mock.method(console, "warn", () => {});
  const calls: string[] = [];
  const { session } = createSession(calls, {
    abort: () => new Promise(() => {}),
  });
  const report = await disconnectCopilotSession(
    session, true, "[test]", { timeoutMs: 5 },
  );
  assert.deepEqual(calls, ["abort", "disconnect"]);
  assert.deepEqual(report.failures.map(({ operation }) => operation), ["abort"]);
});

test("stalled runtime invalidation and release are bounded and reported", async (t) => {
  const keepAlive = setInterval(() => {}, 1_000);
  t.after(() => clearInterval(keepAlive));
  const warning = t.mock.method(console, "warn", () => {});
  const lease = {
    client: {},
    generation: 1,
    invalidate: () => new Promise<boolean>(() => {}),
    release: () => new Promise<void>(() => {}),
  };
  assert.equal(await invalidateRuntimeForCleanupFailure(
    lease,
    { failures: [{ operation: "abort", error: new CopilotCleanupTimeoutError("abort", 5) }] },
    "[test]",
    { timeoutMs: 5 },
  ), false);
  const error = await releaseRuntimeLease(lease, "[test]", { timeoutMs: 5 });
  assert.ok(error instanceof CopilotCleanupTimeoutError);
  assert.equal(error.operation, "release-runtime");
  assert.equal(warning.mock.callCount(), 2);
});
