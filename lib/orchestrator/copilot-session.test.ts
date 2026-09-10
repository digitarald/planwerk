import assert from "node:assert/strict";
import { test } from "node:test";

import { disposeOneShotSession } from "./copilot-session.ts";

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

  await disposeOneShotSession(client, session, false, "[test]");

  assert.deepEqual(calls, ["delete"]);
});

test("disposeOneShotSession aborts in-flight work before deletion", async () => {
  const calls: string[] = [];
  const { client, session } = createSession(calls);

  await disposeOneShotSession(client, session, true, "[test]");

  assert.deepEqual(calls, ["abort", "delete"]);
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
    await disposeOneShotSession(client, session, false, "[test]");
  } finally {
    console.warn = originalWarn;
  }

  assert.deepEqual(calls, ["delete", "disconnect"]);
  assert.equal(warnings.length, 1);
  assert.match(String(warnings[0][0]), /Failed to delete/);
});
