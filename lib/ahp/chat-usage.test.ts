import assert from "node:assert/strict";
import test from "node:test";
import type { ChatState } from "@microsoft/agent-host-protocol";
import { projectChatUsage } from "./chat-usage.ts";

const state = (value: object) => ({
  resource: "ahp-chat:/usage", title: "Usage", status: 1, modifiedAt: "2026-10-31T00:00:00Z", turns: [], ...value,
}) as ChatState;

test("missing usage is unavailable; zero tokens remain measured and models alone are not zero receipts", () => {
  assert.equal(projectChatUsage(state({ turns: [{ id: "a" }] })), undefined);
  const zero = projectChatUsage(state({ turns: [{ id: "a", usage: { inputTokens: 0, outputTokens: 0 } }] }))!;
  assert.equal(zero.inputTokens, 0); assert.equal(zero.outputTokens, 0); assert.equal(zero.partial, false);
  const model = projectChatUsage(state({ turns: [{ id: "a", usage: { model: "Model" } }] }))!;
  assert.equal(model.inputTokens, undefined); assert.equal(model.measuredTurns, 0); assert.equal(model.partial, true);
});

test("partial receipts retain unavailable fields and never add cached input twice", () => {
  const usage = projectChatUsage(state({
    turns: [{ id: "a", usage: { outputTokens: 10, cacheReadTokens: 4 } }, { id: "b" }],
    turnsNextCursor: "older",
  }))!;
  assert.equal(usage.inputTokens, undefined);
  assert.equal(usage.outputTokens, 10);
  assert.equal(usage.cacheReadTokens, 4);
  assert.equal(usage.partial, true);
  assert.equal(usage.hasOlderTurns, true);
  assert.equal(usage.scope, "loaded-turns");
});

test("stable IDs deduplicate receipts, active updates and loaded pages without a cumulative ledger", () => {
  const turn = { id: "a", usage: { inputTokens: 10, outputTokens: 5, model: "one" } };
  const usage = projectChatUsage(state({
    turns: [turn, turn],
    activeTurn: { id: "a", usage: { inputTokens: 12, outputTokens: 6, model: "two" } },
  }), "now")!;
  assert.equal(usage.inputTokens, 12);
  assert.equal(usage.loadedTurns, 1);
  assert.deepEqual(usage.models, ["two"]);
  assert.equal(usage.observedAt, "now");
  const page = projectChatUsage(state({ turns: [{ id: "old", usage: { inputTokens: 3, outputTokens: 2 } }, turn] }))!;
  assert.equal(page.inputTokens, 13);
  assert.equal(projectChatUsage(state({ turns: [turn] }))!.inputTokens, 10);
});

test("invalid receipts are unavailable rather than contaminating a subtotal", () => {
  const usage = projectChatUsage(state({ turns: [{ id: "a", usage: { inputTokens: NaN, outputTokens: -1, cacheReadTokens: Infinity } }] }));
  assert.equal(usage, undefined);
});
