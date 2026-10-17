import assert from "node:assert/strict";
import { test } from "node:test";

import Database from "better-sqlite3";
import type { SessionConfig } from "@github/copilot-sdk";

import { ensureCtoContinuitySchema } from "../db/cto-continuity-schema.ts";
import { CtoContinuityStore } from "../db/cto-continuity-store.ts";
import {
  CtoSessionCleanupTimeoutError,
  CtoSessionLeaseBusyError,
  CtoSessionLeaseLostError,
  CtoSessionManager,
  type CtoSessionClient,
} from "./cto-session-manager.ts";
import {
  classifyCopilotFailure,
  CopilotRuntimeManager,
  type ManagedCopilotRuntimeClient,
} from "./sdk-runtime-manager.ts";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function manualRenewalScheduler() {
  const callbacks = new Set<() => void>();
  return {
    set(callback: () => void) {
      callbacks.add(callback);
      return callback;
    },
    clear(handle: unknown) {
      callbacks.delete(handle as () => void);
    },
    tick() {
      for (const callback of [...callbacks]) callback();
    },
    get activeCount() {
      return callbacks.size;
    },
  };
}

function harness() {
  const db = new Database(":memory:");
  ensureCtoContinuitySchema(db);
  const store = new CtoContinuityStore(db);
  const calls: string[] = [];
  let sessionCounter = 0;
  const sessions = new Set<string>();
  const makeSession = (sessionId: string) => ({
    sessionId,
    abort: async () => { calls.push(`abort:${sessionId}`); },
    disconnect: async () => { calls.push(`disconnect:${sessionId}`); },
    on: () => () => {},
    sendAndWait: async () => undefined,
  });
  const client: CtoSessionClient = {
    createSession: async () => {
      const id = `created-${++sessionCounter}`;
      sessions.add(id);
      calls.push(`create:${id}`);
      return makeSession(id);
    },
    resumeSession: async (id) => {
      calls.push(`resume:${id}`);
      if (!sessions.has(id)) throw new Error("session not found");
      return makeSession(id);
    },
    getSessionMetadata: async (id) =>
      sessions.has(id) ? { sessionId: id } : undefined,
    deleteSession: async (id) => {
      calls.push(`delete:${id}`);
      if (!sessions.delete(id)) throw new Error("session not found");
    },
  };
  return { db, store, calls, client, sessions, makeSession };
}

const config = { model: "model-1", availableTools: [] } satisfies SessionConfig;

test("only the persisted coordinator ID is looked up and resumed, never a foreign session", async () => {
  const { db, store, calls, client, sessions } = harness();
  sessions.add("foreign-vscode-session");
  const metadataIds: string[] = [];
  const getMetadata = client.getSessionMetadata;
  client.getSessionMetadata = async (id) => {
    metadataIds.push(id);
    return getMetadata(id);
  };
  const manager = new CtoSessionManager(store);
  const created = await manager.open(client, "model-1", config);
  await created.release();
  assert.deepEqual(metadataIds, []);
  const resumed = await manager.open(client, "model-1", config);
  await resumed.release();
  assert.deepEqual(metadataIds, ["created-1"]);
  assert.equal(calls.some((call) => call.includes("foreign-vscode-session")), false);
  assert.equal(sessions.has("foreign-vscode-session"), true);
  db.close();
});

test("creates once, persists the ID, resumes, and disconnects without deletion", async () => {
  const { db, store, calls, client } = harness();
  const manager = new CtoSessionManager(store);
  const first = await manager.open(client, "model-1", config);
  assert.equal(first.resumed, false);
  await first.release();

  const restarted = new CtoSessionManager(new CtoContinuityStore(db));
  const second = await restarted.open(client, "model-1", config);
  assert.equal(second.resumed, true);
  await second.release();

  assert.deepEqual(calls, [
    "create:created-1",
    "disconnect:created-1",
    "resume:created-1",
    "disconnect:created-1",
  ]);
  assert.equal(store.getSession()?.sessionId, "created-1");
  db.close();
});

test("invalid persisted session creates a replacement and explicit clear deletes it", async () => {
  const { db, store, calls, client } = harness();
  store.setSession("missing", "old-model");
  const manager = new CtoSessionManager(store);

  const handle = await manager.open(client, "new-model", config);
  assert.equal(handle.session.sessionId, "created-1");
  await handle.release();
  assert.equal(await manager.clear(client), true);
  assert.equal(store.getSession(), null);
  assert.deepEqual(calls, [
    "create:created-1",
    "disconnect:created-1",
    "delete:created-1",
  ]);
  db.close();
});

test("session manager holds the SQLite lease until release", async () => {
  const { db, store, client } = harness();
  const first = new CtoSessionManager(store);
  const second = new CtoSessionManager(new CtoContinuityStore(db));
  const handle = await first.open(client, "model-1", config);

  await assert.rejects(
    second.open(client, "model-1", config),
    CtoSessionLeaseBusyError
  );
  await handle.release();
  const recovered = await second.open(client, "model-1", config);
  await recovered.release({ abort: true });
  db.close();
});

test("resume receives the current tools, hooks, and permission handler", async () => {
  const { db, store, client, sessions } = harness();
  sessions.add("persisted");
  store.setSession("persisted", "old-model");
  let resumedConfig: SessionConfig | undefined;
  const originalResume = client.resumeSession;
  client.resumeSession = async (id, currentConfig) => {
    resumedConfig = currentConfig;
    return originalResume(id, currentConfig);
  };
  const manager = new CtoSessionManager(store);
  const currentConfig = {
    model: "new-model",
    tools: [{ name: "current-tool" }],
    availableTools: ["current-tool"],
    hooks: { onPreToolUse: () => ({ permissionDecision: "allow" as const }) },
    onPermissionRequest: () => ({ kind: "approve-once" as const }),
  } satisfies SessionConfig;

  const handle = await manager.open(client, "new-model", currentConfig);
  await handle.release();

  assert.equal(resumedConfig?.model, "new-model");
  assert.equal(resumedConfig?.tools?.[0].name, "current-tool");
  assert.equal(typeof resumedConfig?.hooks?.onPreToolUse, "function");
  assert.equal(typeof resumedConfig?.onPermissionRequest, "function");
  assert.equal(store.getSession()?.modelId, "new-model");
  db.close();
});

test("persistence failure deletes a newly created session before releasing the lease", async () => {
  const { db, store, calls, client } = harness();
  const persistenceError = new Error("sqlite disk write failed");
  const originalSetSession = store.setSession.bind(store);
  store.setSession = () => {
    throw persistenceError;
  };
  const manager = new CtoSessionManager(store);

  await assert.rejects(
    manager.open(client, "model-1", config),
    (error: unknown) => error === persistenceError,
  );

  assert.deepEqual(calls, [
    "create:created-1",
    "delete:created-1",
  ]);

  store.setSession = originalSetSession;
  const recovered = await manager.open(client, "model-1", config);
  await recovered.release();
  assert.equal(recovered.session.sessionId, "created-2");
  db.close();
});

test("new-session deletion failure falls back to abort/disconnect and invalidates the runtime", async () => {
  const { db, store, calls, client, makeSession } = harness();
  const persistenceError = new Error("sqlite disk write failed");
  const disconnectError = Object.assign(new Error("socket closed"), {
    code: "ECONNRESET",
  });
  client.createSession = async () => {
    calls.push("create:broken");
    const session = makeSession("broken");
    session.disconnect = async () => {
      calls.push("disconnect:broken");
      throw disconnectError;
    };
    return session;
  };
  store.setSession = () => {
    throw persistenceError;
  };
  const invalidations: unknown[] = [];
  const warnings: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(args);

  try {
    await assert.rejects(
      new CtoSessionManager(store).open(client, "model-1", config, {
        invalidateRuntime: async (reason) => {
          invalidations.push(reason);
        },
      }),
      (error: unknown) => error === persistenceError,
    );
  } finally {
    console.warn = originalWarn;
  }

  assert.deepEqual(calls, [
    "create:broken",
    "delete:broken",
    "abort:broken",
    "disconnect:broken",
  ]);
  assert.equal(invalidations.length, 1);
  assert.match(String(invalidations[0]), /session not found/);
  assert.equal(warnings.length, 2);
  assert.match(String(warnings[0][0]), /Failed to delete/);
  assert.match(String(warnings[1][0]), /Failed to disconnect/);
  db.close();
});

test("persistence failure preserves a resumed durable session", async () => {
  const { db, store, calls, client, sessions } = harness();
  sessions.add("persisted");
  store.setSession("persisted", "model-1");
  const persistenceError = new Error("sqlite disk write failed");
  store.setSession = () => {
    throw persistenceError;
  };

  await assert.rejects(
    new CtoSessionManager(store).open(client, "model-1", config),
    (error: unknown) => error === persistenceError,
  );

  assert.deepEqual(calls, [
    "resume:persisted",
    "abort:persisted",
    "disconnect:persisted",
  ]);
  assert.equal(sessions.has("persisted"), true);
  assert.equal(store.getSession()?.sessionId, "persisted");
  db.close();
});

test("resumed open failure quarantines before rejected disconnect and blocks replacement resume", async () => {
  const { db, client, calls, sessions, makeSession } = harness();
  const firstStore = new CtoContinuityStore(db);
  const secondStore = new CtoContinuityStore(db);
  sessions.add("persisted");
  firstStore.setSession("persisted", "model-1");
  const persistenceError = new Error("sqlite write failed after resume");
  const disconnectError = new Error("SDK rejected disconnect");
  firstStore.setSession = () => {
    throw persistenceError;
  };
  client.resumeSession = async (sessionId) => {
    calls.push(`resume:${sessionId}`);
    const session = makeSession(sessionId);
    session.disconnect = async () => {
      calls.push(`disconnect:${sessionId}`);
      const binding = firstStore.getSessionBinding();
      assert.equal(binding?.lifecycleState, "deleting");
      assert.ok(binding?.deletionToken);
      throw disconnectError;
    };
    return session;
  };
  const invalidations: unknown[] = [];
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    await assert.rejects(
      new CtoSessionManager(firstStore).open(
        client,
        "model-1",
        config,
        {
          invalidateRuntime: async (reason) => {
            invalidations.push(reason);
            assert.equal(
              secondStore.acquireLease("primary", "worker-b-probe", 30_000),
              false,
            );
          },
        },
      ),
      (error: unknown) => error === persistenceError,
    );
  } finally {
    console.warn = originalWarn;
  }

  assert.deepEqual(invalidations, [disconnectError]);
  assert.equal(firstStore.getSessionBinding()?.lifecycleState, "deleting");
  const reconciliationError = new Error("deletion not confirmed");
  client.deleteSession = async () => {
    throw reconciliationError;
  };
  await assert.rejects(
    new CtoSessionManager(secondStore).open(client, "model-2", config),
    (error: unknown) => error === reconciliationError,
  );
  assert.equal(
    calls.filter((call) => call === "resume:persisted").length,
    1,
  );
  assert.equal(secondStore.getSessionBinding()?.lifecycleState, "deleting");
  db.close();
});

test("resumed open failure keeps timeout quarantined until a second worker reconciles", async () => {
  const { db, client, calls, sessions, makeSession } = harness();
  const firstStore = new CtoContinuityStore(db);
  const secondStore = new CtoContinuityStore(db);
  sessions.add("persisted");
  firstStore.setSession("persisted", "model-1");
  const persistenceError = new Error("sqlite write failed after resume");
  firstStore.setSession = () => {
    throw persistenceError;
  };
  const disconnect = deferred();
  client.resumeSession = async (sessionId) => {
    calls.push(`resume:${sessionId}`);
    const session = makeSession(sessionId);
    session.disconnect = async () => {
      calls.push(`disconnect:${sessionId}`);
      await disconnect.promise;
    };
    return session;
  };
  const invalidations: unknown[] = [];
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    await assert.rejects(
      new CtoSessionManager(
        firstStore,
        50,
        undefined,
        manualRenewalScheduler(),
        5,
      ).open(client, "model-1", config, {
        invalidateRuntime: async (reason) => {
          invalidations.push(reason);
        },
      }),
      (error: unknown) => error === persistenceError,
    );
  } finally {
    console.warn = originalWarn;
  }

  assert.ok(invalidations[0] instanceof CtoSessionCleanupTimeoutError);
  assert.equal(firstStore.getSessionBinding()?.lifecycleState, "deleting");
  const reconciliation = deferred();
  client.deleteSession = async (sessionId) => {
    calls.push(`delete:${sessionId}`);
    await reconciliation.promise;
    sessions.delete(sessionId);
  };
  const replacing = new CtoSessionManager(secondStore).open(
    client,
    "model-2",
    config,
  );
  await Promise.resolve();
  assert.equal(
    calls.filter((call) => call === "resume:persisted").length,
    1,
  );
  assert.equal(
    calls.some((call) => call === "create:created-1"),
    false,
  );
  assert.equal(secondStore.getSessionBinding()?.lifecycleState, "deleting");

  reconciliation.resolve();
  const replacement = await replacing;
  assert.equal(replacement.resumed, false);
  assert.equal(replacement.session.sessionId, "created-1");
  await replacement.release();
  disconnect.resolve();
  db.close();
});

test("confirmed resumed open cleanup restores the binding for recovery", async () => {
  const { db, client, calls, sessions } = harness();
  const firstStore = new CtoContinuityStore(db);
  const secondStore = new CtoContinuityStore(db);
  sessions.add("persisted");
  firstStore.setSession("persisted", "model-1");
  const persistenceError = new Error("sqlite write failed after resume");
  firstStore.setSession = () => {
    throw persistenceError;
  };
  let invalidations = 0;

  await assert.rejects(
    new CtoSessionManager(firstStore).open(client, "model-1", config, {
      invalidateRuntime: async () => {
        invalidations++;
      },
    }),
    (error: unknown) => error === persistenceError,
  );

  assert.equal(invalidations, 0);
  assert.deepEqual(firstStore.getSessionBinding(), {
    sessionId: "persisted",
    modelId: "model-1",
    lifecycleState: "active",
    deletionToken: null,
    deletionStartedAtMs: null,
  });
  const recovered = await new CtoSessionManager(secondStore).open(
    client,
    "model-2",
    config,
  );
  assert.equal(recovered.resumed, true);
  assert.equal(recovered.session.sessionId, "persisted");
  await recovered.release();
  assert.deepEqual(calls, [
    "resume:persisted",
    "abort:persisted",
    "disconnect:persisted",
    "resume:persisted",
    "disconnect:persisted",
  ]);
  db.close();
});

test("stale resumed owner cannot quarantine or clear a replacement binding", async () => {
  const { db, client, calls, sessions } = harness();
  let now = 8_000;
  const firstStore = new CtoContinuityStore(db, () => now);
  const secondStore = new CtoContinuityStore(db, () => now);
  sessions.add("persisted");
  firstStore.setSession("persisted", "model-1");
  const originalSet = firstStore.setSessionIfLeaseOwner.bind(firstStore);
  firstStore.setSessionIfLeaseOwner = (...args) => {
    now = 8_051;
    assert.equal(
      secondStore.acquireLease("primary", "worker-b", 50),
      true,
    );
    secondStore.setSession("replacement", "model-2");
    return originalSet(...args);
  };
  let invalidations = 0;
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    await assert.rejects(
      new CtoSessionManager(
        firstStore,
        50,
        undefined,
        manualRenewalScheduler(),
        5,
      ).open(client, "model-1", config, {
        invalidateRuntime: async () => {
          invalidations++;
        },
      }),
      CtoSessionLeaseLostError,
    );
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(invalidations, 1);
  assert.deepEqual(calls, ["resume:persisted"]);
  assert.deepEqual(secondStore.getSessionBinding(), {
    sessionId: "replacement",
    modelId: "model-2",
    lifecycleState: "active",
    deletionToken: null,
    deletionStartedAtMs: null,
  });
  assert.equal(secondStore.releaseLease("primary", "worker-b"), true);
  db.close();
});

test("created binding is quarantined before cleanup when persistence throws after write", async () => {
  const { db, client, calls, store } = harness();
  const persistenceError = new Error("sqlite failed after commit");
  const originalSet = store.setSessionIfLeaseOwner.bind(store);
  store.setSessionIfLeaseOwner = (...args) => {
    assert.equal(originalSet(...args), true);
    throw persistenceError;
  };
  const originalDelete = client.deleteSession;
  client.deleteSession = async (sessionId) => {
    const binding = store.getSessionBinding();
    assert.equal(binding?.sessionId, sessionId);
    assert.equal(binding?.lifecycleState, "deleting");
    assert.ok(binding?.deletionToken);
    await originalDelete(sessionId);
  };

  await assert.rejects(
    new CtoSessionManager(store).open(client, "model-1", config),
    (error: unknown) => error === persistenceError,
  );

  assert.equal(store.getSessionBinding(), null);
  assert.deepEqual(calls, ["create:created-1", "delete:created-1"]);
  db.close();
});

test("renewal exceptions abort the session and surface through cleanup", async () => {
  const { db, store, calls, client } = harness();
  let renew: (() => void) | undefined;
  const scheduler = {
    set(callback: () => void) {
      renew = callback;
      return {};
    },
    clear() {},
  };
  const manager = new CtoSessionManager(
    store,
    120_000,
    undefined,
    scheduler,
  );
  const handle = await manager.open(client, "model-1", config);
  store.renewLease = () => {
    throw new Error("injected SQLite renewal failure");
  };

  renew!();
  await Promise.resolve();
  const warnings: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(args);
  let report;
  try {
    report = await handle.release();
  } finally {
    console.warn = originalWarn;
  }

  assert.deepEqual(calls, [
    "create:created-1",
    "abort:created-1",
    "disconnect:created-1",
  ]);
  assert.equal(report.failures[0]?.operation, "renew-lease");
  assert.match(String(report.failures[0]?.error), /renewed/);
  assert.equal(warnings.length, 1);
  db.close();
});

test("slow clear renews beyond the original lease and excludes a second worker", async () => {
  const { db, client } = harness();
  let now = 1_000;
  const firstStore = new CtoContinuityStore(db, () => now);
  const secondStore = new CtoContinuityStore(db, () => now);
  firstStore.setSession("slow-session", "model-1");
  const deletion = deferred();
  client.deleteSession = async () => deletion.promise;
  const scheduler = manualRenewalScheduler();
  const first = new CtoSessionManager(
    firstStore,
    90,
    undefined,
    scheduler,
    80,
  );
  const second = new CtoSessionManager(secondStore, 90);

  const clearing = first.clear(client);
  now = 1_031;
  scheduler.tick();
  now = 1_091;
  await assert.rejects(second.clear(client), CtoSessionLeaseBusyError);

  deletion.resolve();
  assert.equal(await clearing, true);
  assert.equal(firstStore.getSession(), null);
  assert.equal(scheduler.activeCount, 0);
  db.close();
});

test("renewal loss keeps deletion quarantined and fences stale completion", async () => {
  const { db, client } = harness();
  let now = 2_000;
  const firstStore = new CtoContinuityStore(db, () => now);
  const secondStore = new CtoContinuityStore(db, () => now);
  firstStore.setSession("stale-session", "model-1");
  const deletion = deferred();
  client.deleteSession = async () => deletion.promise;
  const scheduler = manualRenewalScheduler();
  const clearer = new CtoSessionManager(
    firstStore,
    90,
    undefined,
    scheduler,
    80,
  );

  const clearing = clearer.clear(client);
  firstStore.renewLease = () => false;
  now = 2_031;
  scheduler.tick();
  now = 2_091;
  assert.equal(secondStore.acquireLease("primary", "worker-b", 90), true);
  assert.throws(
    () => secondStore.setSession("replacement-session", "model-2"),
    /quarantined/,
  );

  deletion.resolve();
  await assert.rejects(clearing, CtoSessionLeaseLostError);
  assert.equal(secondStore.getSession(), null);
  assert.equal(
    secondStore.getSessionBinding()?.sessionId,
    "stale-session",
  );
  assert.equal(secondStore.releaseLease("primary", "worker-b"), true);
  db.close();
});

test("clear timeout quarantines deletion until restart reconciliation", async () => {
  const { db, client } = harness();
  let now = 3_000;
  const firstStore = new CtoContinuityStore(db, () => now);
  const secondStore = new CtoContinuityStore(db, () => now);
  firstStore.setSession("timed-out-session", "model-1");
  const deletion = deferred();
  let deletionCalls = 0;
  client.deleteSession = async () => deletion.promise;
  const scheduler = manualRenewalScheduler();
  const clearer = new CtoSessionManager(
    firstStore,
    50,
    undefined,
    scheduler,
    5,
  );

  await assert.rejects(
    clearer.clear(client),
    CtoSessionCleanupTimeoutError,
  );
  assert.deepEqual(firstStore.getSessionBinding()?.lifecycleState, "deleting");
  assert.throws(
    () => secondStore.setSession("replacement-after-timeout", "model-2"),
    /quarantined/,
  );

  const restartClient = { ...client };
  const restartedDeletion = deferred();
  restartClient.deleteSession = async (sessionId) => {
    deletionCalls++;
    if (deletionCalls === 1) {
      return restartedDeletion.promise;
    }
    throw new Error(`session not found: ${sessionId}`);
  };
  await assert.rejects(
    new CtoSessionManager(
      secondStore,
      50,
      undefined,
      manualRenewalScheduler(),
      5,
    ).open(restartClient, "model-2", config),
    CtoSessionCleanupTimeoutError,
  );
  assert.equal(secondStore.getSessionBinding()?.lifecycleState, "deleting");

  now = 3_001;
  const reconciled = await new CtoSessionManager(
    secondStore,
    50,
    undefined,
    manualRenewalScheduler(),
    5,
  ).open(restartClient, "model-2", config);
  assert.equal(reconciled.session.sessionId, "created-1");
  assert.equal(
    secondStore.getSession()?.sessionId,
    "created-1",
  );
  deletion.resolve();
  restartedDeletion.resolve();
  await Promise.resolve();
  assert.equal(
    secondStore.getSession()?.sessionId,
    "created-1",
  );
  await reconciled.release();
  assert.equal(scheduler.activeCount, 0);
  db.close();
});

test("stale metadata lookup cannot clear a replacement binding", async () => {
  const { db, client } = harness();
  let now = 5_000;
  const firstStore = new CtoContinuityStore(db, () => now);
  const secondStore = new CtoContinuityStore(db, () => now);
  firstStore.setSession("old-session", "model-1");
  const metadata = deferred<unknown | undefined>();
  client.getSessionMetadata = async () => metadata.promise;
  const opening = new CtoSessionManager(
    firstStore,
    50,
    undefined,
    manualRenewalScheduler(),
    5,
  ).open(client, "model-1", config);

  now = 5_051;
  assert.equal(secondStore.acquireLease("primary", "worker-b", 50), true);
  secondStore.setSession("replacement-session", "model-2");
  metadata.resolve(undefined);

  await assert.rejects(opening, CtoSessionLeaseLostError);
  assert.equal(
    secondStore.getSession()?.sessionId,
    "replacement-session",
  );
  assert.equal(secondStore.releaseLease("primary", "worker-b"), true);
  db.close();
});

test("stale invalid-resume completion cannot clear a replacement binding", async () => {
  const { db, client } = harness();
  let now = 6_000;
  const firstStore = new CtoContinuityStore(db, () => now);
  const secondStore = new CtoContinuityStore(db, () => now);
  firstStore.setSession("old-session", "model-1");
  client.getSessionMetadata = async () => ({ sessionId: "old-session" });
  const resume = deferred<never>();
  client.resumeSession = async () => resume.promise;
  const opening = new CtoSessionManager(
    firstStore,
    50,
    undefined,
    manualRenewalScheduler(),
    5,
  ).open(client, "model-1", config);

  await Promise.resolve();
  now = 6_051;
  assert.equal(secondStore.acquireLease("primary", "worker-b", 50), true);
  secondStore.setSession("replacement-session", "model-2");
  resume.reject(new Error("session not found"));

  await assert.rejects(opening, CtoSessionLeaseLostError);
  assert.equal(
    secondStore.getSession()?.sessionId,
    "replacement-session",
  );
  assert.equal(secondStore.releaseLease("primary", "worker-b"), true);
  db.close();
});

test("disconnect timeout quarantines across workers and fences late completion", async () => {
  const { db, client, calls } = harness();
  let now = 7_000;
  const firstStore = new CtoContinuityStore(db, () => now);
  const secondStore = new CtoContinuityStore(db, () => now);
  const disconnect = deferred();
  const originalCreate = client.createSession;
  client.createSession = async (currentConfig) => {
    const session = await originalCreate(currentConfig);
    session.disconnect = async () => {
      calls.push(`disconnect:${session.sessionId}`);
      await disconnect.promise;
    };
    return session;
  };
  const invalidations: unknown[] = [];
  const first = new CtoSessionManager(
    firstStore,
    50,
    undefined,
    manualRenewalScheduler(),
    5,
  );
  const handle = await first.open(client, "model-1", config, {
    invalidateRuntime: async (reason) => {
      invalidations.push(reason);
    },
  });

  const originalWarn = console.warn;
  console.warn = () => {};
  let report;
  try {
    report = await handle.release();
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(report.failures.length, 1);
  assert.ok(
    report.failures[0]?.error instanceof CtoSessionCleanupTimeoutError,
  );
  assert.equal(
    classifyCopilotFailure(report.failures[0]?.error),
    "runtime-invalidating",
  );
  assert.equal(invalidations[0], report.failures[0]?.error);
  assert.equal(
    firstStore.getSessionBinding()?.lifecycleState,
    "deleting",
  );

  const reconcile = deferred();
  let deleteCalls = 0;
  const restartClient = {
    ...client,
    deleteSession: async (sessionId: string) => {
      deleteCalls++;
      calls.push(`delete:${sessionId}:${deleteCalls}`);
      if (deleteCalls === 1) await reconcile.promise;
      else throw new Error(`session not found: ${sessionId}`);
    },
  };
  await assert.rejects(
    new CtoSessionManager(
      secondStore,
      50,
      undefined,
      manualRenewalScheduler(),
      5,
    ).open(restartClient, "model-2", config),
    CtoSessionCleanupTimeoutError,
  );
  assert.equal(
    calls.some((call) => call.startsWith("resume:")),
    false,
  );
  assert.equal(
    secondStore.getSessionBinding()?.lifecycleState,
    "deleting",
  );

  now = 7_001;
  const replacement = await new CtoSessionManager(
    secondStore,
    50,
    undefined,
    manualRenewalScheduler(),
    5,
  ).open(restartClient, "model-2", config);
  assert.equal(replacement.resumed, false);
  assert.equal(replacement.session.sessionId, "created-2");
  assert.equal(secondStore.getSession()?.sessionId, "created-2");

  disconnect.resolve();
  reconcile.resolve();
  await Promise.resolve();
  assert.equal(secondStore.getSession()?.sessionId, "created-2");
  await replacement.release();
  db.close();
});

test("immediate disconnect rejection quarantines before another worker can replace it", async () => {
  const { db, client, calls } = harness();
  const firstStore = new CtoContinuityStore(db);
  const secondStore = new CtoContinuityStore(db);
  const disconnectError = new Error("SDK rejected disconnect");
  const originalCreate = client.createSession;
  client.createSession = async (currentConfig) => {
    const session = await originalCreate(currentConfig);
    if (session.sessionId === "created-1") {
      session.disconnect = async () => {
        calls.push(`disconnect:${session.sessionId}`);
        assert.equal(
          firstStore.getSessionBinding()?.lifecycleState,
          "deleting",
        );
        throw disconnectError;
      };
    }
    return session;
  };
  const first = new CtoSessionManager(firstStore);
  const second = new CtoSessionManager(secondStore);
  let invalidations = 0;
  const handle = await first.open(client, "model-1", config, {
    invalidateRuntime: async () => {
      invalidations++;
    },
  });

  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    const releasing = handle.release();
    await assert.rejects(
      second.open(client, "model-2", config),
      CtoSessionLeaseBusyError,
    );
    const report = await releasing;
    assert.equal(report.failures.length, 1);
    assert.equal(report.failures[0]?.operation, "disconnect");
    assert.equal(report.failures[0]?.error, disconnectError);
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(classifyCopilotFailure(disconnectError), "domain");
  assert.equal(invalidations, 1);

  assert.equal(
    firstStore.getSessionBinding()?.lifecycleState,
    "deleting",
  );

  const deletion = deferred();
  client.deleteSession = async (sessionId) => {
    calls.push(`delete:${sessionId}`);
    await deletion.promise;
  };
  const replacing = second.open(client, "model-2", config);
  await Promise.resolve();
  assert.equal(
    calls.some((call) => call === "resume:created-1"),
    false,
  );
  assert.equal(
    calls.some((call) => call === "create:created-2"),
    false,
  );

  deletion.resolve();
  const replacement = await replacing;
  assert.equal(replacement.resumed, false);
  assert.equal(replacement.session.sessionId, "created-2");
  assert.equal(secondStore.getSession()?.sessionId, "created-2");
  await replacement.release();
  db.close();
});

test("two workers replace a runtime after domain disconnect failure without reusing its generation", async () => {
  const { db, client } = harness();
  const firstStore = new CtoContinuityStore(db);
  const secondStore = new CtoContinuityStore(db);
  const runtimeClients: Array<
    CtoSessionClient & ManagedCopilotRuntimeClient & { id: number }
  > = [];
  const createCalls = new Map<number, number>();
  const runtimeManager = new CopilotRuntimeManager({
    createClient: () => {
      const id = runtimeClients.length + 1;
      const runtimeClient = {
        ...client,
        id,
        createSession: async (currentConfig: SessionConfig) => {
          createCalls.set(id, (createCalls.get(id) ?? 0) + 1);
          const session = await client.createSession(currentConfig);
          if (id === 1) {
            session.disconnect = async () => {
              throw new Error("domain disconnect failure");
            };
          }
          return session;
        },
        start: async () => {},
        stop: async () => [],
        forceStop: async () => {},
        ping: async (message = "") => ({
          message,
          timestamp: "2026-09-11T00:00:00.000Z",
          protocolVersion: 2,
        }),
        getStatus: async () => ({
          version: "1.0.13",
          protocolVersion: 2,
        }),
      };
      runtimeClients.push(runtimeClient);
      return runtimeClient;
    },
  });

  const firstRuntime = await runtimeManager.acquireClient();
  const firstHandle = await new CtoSessionManager(firstStore).open(
    firstRuntime.client,
    "model-1",
    config,
    {
      invalidateRuntime: (reason) => {
        assert.equal(
          secondStore.acquireLease("primary", "probe-worker", 120_000),
          false,
        );
        return firstRuntime.invalidate(reason);
      },
    },
  );

  const originalWarn = console.warn;
  console.warn = () => {};
  let firstReport;
  try {
    firstReport = await firstHandle.release();
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(firstReport.failures.length, 1);
  assert.equal(
    firstStore.getSessionBinding()?.lifecycleState,
    "deleting",
  );

  const replacementRuntime = await runtimeManager.acquireClient();
  assert.notEqual(replacementRuntime.client, firstRuntime.client);
  assert.ok(replacementRuntime.generation > firstRuntime.generation);

  const replacementHandle = await new CtoSessionManager(secondStore).open(
    replacementRuntime.client,
    "model-2",
    config,
    {
      invalidateRuntime: (reason) =>
        replacementRuntime.invalidate(reason),
    },
  );
  assert.equal(replacementHandle.resumed, false);
  assert.equal(replacementHandle.session.sessionId, "created-2");
  assert.equal(createCalls.get(1), 1);
  assert.equal(createCalls.get(2), 1);

  await firstRuntime.release();
  await replacementHandle.release();
  await replacementRuntime.release();
  db.close();
});

test("abort cleanup failure remains quarantined after disconnect resolves", async () => {
  const { db, client } = harness();
  const store = new CtoContinuityStore(db);
  const abortError = new Error("abort rejected");
  const invalidations: unknown[] = [];
  const originalCreate = client.createSession;
  client.createSession = async (currentConfig) => {
    const session = await originalCreate(currentConfig);
    session.abort = async () => {
      throw abortError;
    };
    return session;
  };
  const handle = await new CtoSessionManager(store).open(
    client,
    "model-1",
    config,
    {
      invalidateRuntime: async (reason) => {
        invalidations.push(reason);
      },
    },
  );

  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    const report = await handle.release({ abort: true });
    assert.equal(report.failures.length, 1);
    assert.equal(report.failures[0]?.operation, "abort");
    assert.equal(report.failures[0]?.error, abortError);
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(store.getSessionBinding()?.lifecycleState, "deleting");
  assert.deepEqual(invalidations, [abortError]);
  db.close();
});

test("normal release renews throughout a slow disconnect", async () => {
  const { db, client } = harness();
  let now = 4_000;
  const firstStore = new CtoContinuityStore(db, () => now);
  const secondStore = new CtoContinuityStore(db, () => now);
  const scheduler = manualRenewalScheduler();
  const disconnect = deferred();
  const originalCreate = client.createSession;
  client.createSession = async (currentConfig) => {
    const session = await originalCreate(currentConfig);
    session.disconnect = async () => disconnect.promise;
    return session;
  };
  const first = new CtoSessionManager(
    firstStore,
    90,
    undefined,
    scheduler,
    80,
  );
  const second = new CtoSessionManager(secondStore, 90);
  const handle = await first.open(client, "model-1", config);

  const releasing = handle.release();
  now = 4_031;
  scheduler.tick();
  now = 4_091;
  await assert.rejects(
    second.open(client, "model-1", config),
    CtoSessionLeaseBusyError,
  );

  disconnect.resolve();
  assert.deepEqual((await releasing).failures, []);
  assert.equal(firstStore.getSessionBinding()?.lifecycleState, "active");
  assert.equal(scheduler.activeCount, 0);
  db.close();
});
