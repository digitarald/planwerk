import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionEvent } from "@github/copilot-sdk";
import { createSdkUsageTracker } from "./sdk-usage.ts";

const base = { id: "event", parentId: null, timestamp: "2026-01-01T00:00:00Z", ephemeral: true as const };
const usage: Extract<SessionEvent, { type: "assistant.usage" }> = { ...base, type: "assistant.usage", data: {
  model: "model", inputTokens: 10, outputTokens: 2,
  accounting: { sourceSessionId: "session", sequence: 1, usageId: "call-1" },
} };
test("observed usage is scoped, deduplicated and unknown values remain absent", () => {
  const track = createSdkUsageTracker();
  assert.deepEqual(track(usage)?.models, [{ provider: "Unknown provider", model: "model", inputTokens: 10, outputTokens: 2 }]);
  assert.equal(track({ ...usage, id: "replay" }), null);
  const missing: SessionEvent = { ...base, id: "missing", type: "assistant.usage", data: { model: "other" } };
  assert.deepEqual(track(missing)?.models[1], { provider: "Unknown provider", model: "other", inputTokens: undefined, outputTokens: undefined, partial: true });
  assert.equal(track({ ...missing, id: "next" })?.scope, "observed-stream");
});
test("checkpoint replaces receipts; watermarks exclude replay and late preceding receipts", () => {
  const track = createSdkUsageTracker();
  track(usage);
  const checkpoint: SessionEvent = { ...base, id: "checkpoint", type: "session.usage_checkpoint", data: {
    providerModelMetrics: [{
      provider: null, modelId: "model",
      metrics: { usage: { inputTokens: 50, outputTokens: 8, cacheReadTokens: 0, cacheWriteTokens: 0 }, requests: { count: 2, cost: 2 } },
    }],
    totalNanoAiu: 250, usageAccountingWatermarks: { session: 2 },
  } };
  assert.equal(track(checkpoint)?.models[0].inputTokens, 50);
  assert.equal(track({ ...usage, id: "late", data: { ...usage.data, accounting: { sourceSessionId: "session", sequence: 2, usageId: "call-2" } } }), null);
  const next = track({ ...usage, id: "next", data: { ...usage.data, accounting: { sourceSessionId: "session", sequence: 3, usageId: "call-3" } } });
  assert.equal(next?.models[0].inputTokens, 60);
  assert.equal(next?.totalNanoAiu, 250);
  assert.equal(next?.scope, "session-checkpoint");
  assert.equal(track(checkpoint), null);
});
test("legacy receipts after checkpoint and child checkpoints cannot inflate session accounting", () => {
  const track = createSdkUsageTracker();
  const checkpoint: SessionEvent = { ...base, type: "session.usage_checkpoint", data: { totalNanoAiu: 0 } };
  assert.equal(track({ ...checkpoint, agentId: "child" }), null);
  track(checkpoint);
  assert.equal(track({ ...base, id: "legacy", type: "assistant.usage", data: { model: "model", inputTokens: 10 } }), null);
});

test("each checkpoint replaces watermark authority rather than inheriting old coverage", () => {
  const track = createSdkUsageTracker();
  track({ ...base, id: "first", type: "session.usage_checkpoint", data: {
    usageAccountingWatermarks: { session: 1 }, totalNanoAiu: 10,
  } });
  const checkpoint: SessionEvent = { ...base, id: "second", type: "session.usage_checkpoint", data: {
    totalNanoAiu: 20,
  } };
  assert.deepEqual(track(checkpoint)?.models, []);
  assert.equal(track({ ...usage, data: { ...usage.data, accounting: {
    sourceSessionId: "session", sequence: 2, usageId: "unknown-coverage",
  } } }), null, "An older checkpoint's watermark must not authorize receipts against a newer snapshot");
});
