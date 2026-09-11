import assert from "node:assert/strict";
import { test } from "node:test";

import type { SessionEvent } from "@github/copilot-sdk";

import {
  createSdkEventMapper,
  mapSdkFailure,
} from "./orchestrator-stream.ts";

function sdkEvent(event: unknown): SessionEvent {
  return event as SessionEvent;
}

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
