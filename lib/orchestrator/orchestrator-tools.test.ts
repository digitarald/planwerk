import assert from "node:assert/strict";
import { test } from "node:test";

import type {
  ToolInvocation,
  ToolResultObject,
} from "@github/copilot-sdk";

import {
  createOrchestratorSdkTools,
  createToolAuditKey,
  ORCHESTRATOR_TOOLS,
  validateToolArguments,
} from "./orchestrator-tools.ts";

function invocation(toolName: string): ToolInvocation {
  return {
    sessionId: "session-1",
    toolCallId: "call-7",
    toolName,
    arguments: {},
  };
}

test("native SDK tools reuse every CTO action schema", () => {
  const sdkTools = createOrchestratorSdkTools({
    dispatch: async () => ({ success: true, message: "ok" }),
  });

  assert.deepEqual(
    sdkTools.map((tool) => tool.name),
    ORCHESTRATOR_TOOLS.map((tool) => tool.function.name),
  );
  assert.equal(sdkTools.every((tool) => tool.handler), true);
  assert.equal(
    sdkTools[0].parameters,
    ORCHESTRATOR_TOOLS[0].function.parameters,
  );
});

test("tool handler validates and dispatches typed arguments with a stable audit key", async () => {
  const calls: unknown[] = [];
  const events: unknown[] = [];
  const [tool] = createOrchestratorSdkTools({
    dispatch: async (name, args, auditKey) => {
      calls.push({ name, args, auditKey });
      return { success: true, message: "created" };
    },
    onResult: (event) => events.push(event),
  });

  const result = (await tool.handler!(
    { title: "Implement tools", prompt: "Implement native tools", workingDirectory: "/workspace" },
    invocation("create_session"),
  )) as ToolResultObject;

  const auditKey = "cto-tool:v1:session-1:call-7";
  assert.deepEqual(calls, [{
    name: "create_session",
    args: { title: "Implement tools", prompt: "Implement native tools", workingDirectory: "/workspace" },
    auditKey,
  }]);
  assert.equal(result.resultType, "success");
  assert.deepEqual(JSON.parse(result.textResultForLlm), {
    success: true,
    message: "created",
    auditKey,
  });
  assert.equal(
    (events[0] as { auditKey: string }).auditKey,
    auditKey,
  );
  assert.equal(
    createToolAuditKey(invocation("create_session")),
    auditKey,
  );
});

test("invalid tool arguments fail before dispatch", async () => {
  let dispatches = 0;
  const tools = createOrchestratorSdkTools({
    dispatch: async () => {
      dispatches++;
      return { success: true, message: "unexpected" };
    },
  });
  const triggerGate = tools.find((tool) => tool.name === "trigger_gate")!;

  const result = (await triggerGate.handler!(
    { cardId: "card-1", gateType: "deploy" },
    invocation("trigger_gate"),
  )) as ToolResultObject;

  assert.equal(dispatches, 0);
  assert.equal(result.resultType, "failure");
  assert.match(result.error ?? "", /gateType must be one of/);
  assert.throws(
    () => validateToolArguments("send_message", {
      cardId: "card-1",
      message: "hello",
      unexpected: true,
    }),
    /unexpected argument/,
  );
});
