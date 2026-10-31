import assert from "node:assert/strict";
import { test } from "node:test";
import type { CopilotSession, SessionEvent } from "@github/copilot-sdk";
import { sendSdkTurn } from "./sdk-turn.ts";

function harness(sendEvents: SessionEvent[], neverAdmit = false) {
  const handlers = new Set<(event: SessionEvent) => void>();
  const session: Pick<CopilotSession, "send" | "on"> = {
    on: (handler: (event: SessionEvent) => void) => { handlers.add(handler); return () => { handlers.delete(handler); }; },
    send: async () => {
      for (const event of sendEvents) for (const handler of handlers) handler(event);
      if (neverAdmit) return new Promise<string>(() => {});
      return "submitted";
    },
  };
  return { session, handlers };
}
const base = { id: "event", parentId: null, timestamp: "2026-01-01T00:00:00Z", ephemeral: true as const };
function warning(messageId: string): SessionEvent {
  return { ...base, type: "session.warning", data: {
    warningType: "policy_blocked", message: "Organization policy blocked this request.", originatingMessageId: messageId,
  } };
}
const user: SessionEvent = { ...base, type: "user.message", data: {
  messageId: "submitted", content: "test", attachments: [],
} };
const idle: SessionEvent = { ...base, type: "session.idle", data: {} };

test("correlates policy blocks emitted before admission, without user.message or idle", async () => {
  const { session, handlers } = harness([warning("other"), warning("submitted")]);
  assert.deepEqual(await sendSdkTurn(session, { prompt: "test" }, 1000, new AbortController().signal), {
    status: "blocked", messageId: "submitted", message: "Organization policy blocked this request.",
  });
  assert.equal(handlers.size, 0);
});
test("unrelated and subagent policy blocks do not replace a completed submission", async () => {
  const { session } = harness([warning("other"), { ...warning("submitted"), agentId: "child" }, idle, user, idle]);
  assert.deepEqual(await sendSdkTurn(session, { prompt: "test" }, 1000, new AbortController().signal), {
    status: "completed", messageId: "submitted",
  });
});
test("admission timeout unsubscribes and never resubmits", async () => {
  const { session, handlers } = harness([], true);
  let pending = false;
  await assert.rejects(sendSdkTurn(session, { prompt: "test" }, 5, new AbortController().signal, (value) => { pending = value; }), /Timeout/);
  assert.equal(handlers.size, 0);
  assert.equal(pending, true, "cleanup must retire a runtime with unresolved admission");
});
test("late admission cannot emit an outcome after interruption", async () => {
  let admit!: (id: string) => void;
  const { session, handlers } = harness([]);
  session.send = () => new Promise<string>((resolve) => { admit = resolve; });
  let pending = false;
  await assert.rejects(sendSdkTurn(session, { prompt: "test" }, 5, new AbortController().signal, (value) => { pending = value; }), /Timeout/);
  assert.equal(pending, true);
  admit("submitted");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(pending, false);
  assert.equal(handlers.size, 0);
});
test("abort releases completion listener", async () => {
  const abort = new AbortController();
  const { session, handlers } = harness([], true);
  const result = sendSdkTurn(session, { prompt: "test" }, 1000, abort.signal);
  abort.abort(new Error("Cancelled"));
  await assert.rejects(result, /Cancelled/);
  assert.equal(handlers.size, 0);
});

test("global errors reject during unresolved admission without waiting for timeout", async () => {
  const { session, handlers } = harness([{
    ...base, type: "session.error", data: { errorType: "connection", message: "Runtime unavailable" },
  }], true);
  await assert.rejects(sendSdkTurn(session, { prompt: "test" }, 1000, new AbortController().signal), /Runtime unavailable/);
  assert.equal(handlers.size, 0);
});

test("cancellation during subscription prevents admission", async () => {
  const abort = new AbortController();
  const { session, handlers } = harness([]);
  const subscribe = session.on;
  session.on = (handler: (event: SessionEvent) => void) => {
    const unsubscribe = subscribe(handler);
    abort.abort(new Error("Cancelled during subscription"));
    return unsubscribe;
  };
  session.send = async () => { assert.fail("Cancelled turns must not be submitted"); };
  await assert.rejects(sendSdkTurn(session, { prompt: "test" }, 1000, abort.signal), /Cancelled during subscription/);
  assert.equal(handlers.size, 0);
});

test("shutdown during admission and aborted idle are explicit failures", async () => {
  const shutdown: SessionEvent = { ...base, type: "session.shutdown", data: {
    codeChanges: { filesModified: [], linesAdded: 0, linesRemoved: 0 },
    modelMetrics: {}, sessionStartTime: 0, shutdownType: "routine", totalApiDurationMs: 0,
  } };
  for (const events of [
    [shutdown],
    [user, { ...idle, data: { aborted: true } }],
  ]) {
    const { session, handlers } = harness(events);
    await assert.rejects(sendSdkTurn(session, { prompt: "test" }, 1000, new AbortController().signal), /ended|aborted/);
    assert.equal(handlers.size, 0);
  }
});
