import assert from "node:assert/strict";
import { test } from "node:test";

import type { SessionEvent } from "@github/copilot-sdk";

import {
  createSdkEventMapper,
  isPrimarySdkSessionTermination,
  mapSdkFailure,
} from "./orchestrator-stream.ts";

function sdkEvent(event: unknown): SessionEvent {
  return event as SessionEvent;
}

test("primary warnings are durable stream facts, deduplicated and never assistant errors", () => {
  const mapper = createSdkEventMapper(new Map());
  const warning = sdkEvent({
    id: "warning", type: "session.warning", data: {
      message: "Blocked", warningType: "policy_blocked", originatingMessageId: "request",
    },
  });
  assert.deepEqual(mapper.map(warning), { type: "warning", id: "warning", ...warning.data });
  assert.equal(mapper.map(warning), null);
  assert.equal(mapper.error, null);
  assert.equal(mapper.content, "");
  assert.equal(mapper.map({ ...warning, id: "child", agentId: "worker" }), null);
});

test("context occupancy and compaction are separate from usage consumption", () => {
  const mapper = createSdkEventMapper(new Map());
  assert.deepEqual(mapper.map(sdkEvent({
    id: "context", timestamp: "now", type: "session.usage_info",
    data: { currentTokens: 40, tokenLimit: 100, messagesLength: 3 },
  })), { type: "context", currentTokens: 40, tokenLimit: 100, compacting: false, updatedAt: "now" });
  assert.deepEqual(mapper.map(sdkEvent({
    id: "start", timestamp: "later", type: "session.compaction_start", data: {},
  })), { type: "context", currentTokens: 40, tokenLimit: 100, compacting: true, updatedAt: "later" });
  assert.deepEqual(mapper.map(sdkEvent({
    id: "failed", timestamp: "latest", type: "session.compaction_complete",
    data: { success: false, error: "Compaction failed", postCompactionTokens: 0 },
  })), { type: "context", currentTokens: 40, tokenLimit: 100, compacting: false, updatedAt: "latest", error: "Compaction failed" });
});

test("message deltas are accumulated while preserving the native delta", () => {
  const mapper = createSdkEventMapper(new Map());

  assert.deepEqual(mapper.map(sdkEvent({
    type: "assistant.message_delta",
    data: { deltaContent: "Hel", messageId: "message-1" },
  })), {
    type: "text",
    content: "Hel",
    delta: "Hel",
  });
  assert.deepEqual(mapper.map(sdkEvent({
    type: "assistant.message_delta",
    data: { deltaContent: "lo", messageId: "message-1" },
  })), {
    type: "text",
    content: "Hello",
    delta: "lo",
  });
  assert.equal(mapper.content, "Hello");
  assert.equal(mapper.map(sdkEvent({
    type: "assistant.message",
    data: { content: "Hello", messageId: "message-1" },
  })), null);
});

test("final messages reconcile by message id and preserve turn order", () => {
  const mapper = createSdkEventMapper(new Map());

  mapper.map(sdkEvent({
    type: "assistant.message_delta",
    data: { deltaContent: "Before", messageId: "pre-tool" },
  }));
  mapper.map(sdkEvent({
    type: "assistant.message_delta",
    data: { deltaContent: "After", messageId: "post-tool" },
  }));

  assert.deepEqual(mapper.map(sdkEvent({
    type: "assistant.message",
    data: { content: "Before tool.", messageId: "pre-tool" },
  })), {
    type: "text",
    content: "Before tool.\n\nAfter",
  });
  assert.deepEqual(mapper.map(sdkEvent({
    type: "assistant.message",
    data: { content: "After tool.", messageId: "post-tool" },
  })), {
    type: "text",
    content: "Before tool.\n\nAfter tool.",
  });
  assert.equal(mapper.content, "Before tool.\n\nAfter tool.");
});

test("tool lifecycle events expose start and recorded completion state", () => {
  const results = new Map([["call-1", {
    toolCallId: "call-1",
    toolName: "send_message" as const,
    auditKey: "cto-tool:v1:session-1:call-1",
    result: {
      success: true,
      message: "Sent message",
      auditKey: "cto-tool:v1:session-1:call-1",
    },
  }]]);
  const mapper = createSdkEventMapper(results);

  assert.deepEqual(mapper.map(sdkEvent({
    type: "tool.execution_start",
    data: { toolName: "send_message", toolCallId: "call-1" },
  })), {
    type: "tool",
    status: "started",
    name: "send_message",
    toolCallId: "call-1",
    result: { message: "Started send_message" },
  });
  assert.deepEqual(mapper.map(sdkEvent({
    type: "tool.execution_complete",
    data: { success: true, toolCallId: "call-1" },
  })), {
    type: "tool",
    status: "completed",
    name: "send_message",
    toolCallId: "call-1",
    result: {
      success: true,
      message: "Sent message",
      auditKey: "cto-tool:v1:session-1:call-1",
    },
  });
});

test("typed SDK and thrown failures are explicit and action-disabled", () => {
  const mapper = createSdkEventMapper(new Map());
  const mapped = mapper.map(sdkEvent({
    type: "session.error",
    data: {
      errorType: "authentication",
      message: "Sign in required",
    },
  }));

  assert.deepEqual(mapped, {
    type: "error",
    status: "error",
    message: "Sign in required",
    errorType: "authentication",
    actionsDisabled: true,
  });
  assert.equal(mapper.error, mapped);
  assert.deepEqual(mapSdkFailure(new TypeError("runtime unavailable"), "degraded"), {
    type: "error",
    status: "degraded",
    message: "runtime unavailable",
    errorType: "TypeError",
    actionsDisabled: true,
  });
});

test("child session errors and shutdowns do not cancel the primary lifecycle", () => {
  const mapper = createSdkEventMapper(new Map());
  const lifecycle = new AbortController();
  for (const type of ["session.error", "session.shutdown"]) {
    const event = sdkEvent({
      type,
      agentId: "child-agent",
      data: { errorType: "child-failed", message: "Child failed" },
    });
    if (isPrimarySdkSessionTermination(event)) lifecycle.abort();
    assert.equal(mapper.map(event), null);
  }
  assert.equal(lifecycle.signal.aborted, false);
  assert.equal(mapper.error, null);
  assert.deepEqual(mapper.map(sdkEvent({
    type: "assistant.message",
    data: { messageId: "primary-message", content: "Primary continued" },
  })), { type: "text", content: "Primary continued" });
});

test("only primary session termination disables the primary lifecycle", () => {
  for (const type of ["session.error", "session.shutdown"]) {
    assert.equal(isPrimarySdkSessionTermination(sdkEvent({ type })), true);
  }
  assert.equal(isPrimarySdkSessionTermination(sdkEvent({
    type: "assistant.message", data: { content: "hello" },
  })), false);
});

test("worker usage contributes without exposing worker dialogue or context", () => {
  const mapper = createSdkEventMapper(new Map());
  assert.equal(mapper.map(sdkEvent({
    id: "worker-usage", agentId: "worker", timestamp: "now", type: "assistant.usage",
    data: { model: "worker-model", inputTokens: 0, outputTokens: 2 },
  }))?.type, "usage");
  for (const [type, data] of [
    ["assistant.message", { messageId: "worker-message", content: "Private worker response" }],
    ["session.usage_info", { currentTokens: 20, tokenLimit: 100 }],
    ["session.compaction_start", {}],
    ["tool.execution_start", { toolName: "read", toolCallId: "worker-call" }],
  ]) {
    assert.equal(mapper.map(sdkEvent({ id: type, type, data, agentId: "worker" })), null);
  }
  assert.equal(mapper.content, "");
});
