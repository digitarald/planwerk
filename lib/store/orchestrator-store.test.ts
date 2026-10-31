import assert from "node:assert/strict";
import { test } from "node:test";
import type { FeedItem } from "./orchestrator-store.ts";
let saved = "";
Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: {
  getItem: () => saved || null,
  setItem: (_key: string, value: string) => { saved = value; },
  removeItem: () => { saved = ""; },
} });
const { closeCtoApprovals, useOrchestratorStore } = await import("./orchestrator-store.ts");

test("blocked submissions retain warnings, settle the spinner and restore an editable draft", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response([
    { type: "warning", id: "warning", warningType: "policy_blocked", message: "Blocked by policy" },
    { type: "warning", id: "warning", warningType: "policy_blocked", message: "Blocked by policy" },
    { type: "done", status: "blocked", message: "Blocked by policy" },
  ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } }));
  useOrchestratorStore.setState({ feedItems: [], draft: "" });
  await useOrchestratorStore.getState().sendMessage("original");
  const state = useOrchestratorStore.getState();
  assert.equal(state.isProcessing, false);
  assert.equal(state.draft, "original");
  assert.equal(state.feedItems.filter((item) => item.type === "alert").length, 1);
  assert.equal(state.feedItems.find((item) => item.type === "response")?.submissionStatus, "blocked");
  assert.equal(state.feedItems.find((item) => item.type === "response")?.message, "Not submitted: Blocked by policy");
  assert.equal(state.feedItems.find((item) => item.type === "user")?.submissionStatus, "blocked");
  assert.equal(JSON.parse(saved).state.feedItems.find((item: FeedItem) => item.type === "user").submissionStatus, "blocked");
});

test("warnings stay nonfatal and persisted observations stop showing live compaction at completion", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response([
    { type: "warning", id: "notice", warningType: "notice", message: "Model changed" },
    { type: "context", currentTokens: 0, tokenLimit: 100, compacting: true, updatedAt: "2026-01-01T00:00:00Z" },
    { type: "usage", usage: { scope: "observed-stream", models: [{ provider: "Provider", model: "Model", outputTokens: 0 }], updatedAt: "2026-01-01T00:00:00Z" } },
    { type: "text", content: "Complete" },
    { type: "done", status: "success" },
  ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } }));
  useOrchestratorStore.setState({ feedItems: [], draft: "" });
  await useOrchestratorStore.getState().sendMessage("request");
  const state = useOrchestratorStore.getState();
  const response = state.feedItems.find((item) => item.type === "response");
  assert.equal(response?.message, "Complete");
  assert.equal(response?.context?.compacting, false);
  assert.equal(response?.context?.currentTokens, 0);
  assert.equal(response?.usage?.models[0].inputTokens, undefined);
  assert.equal(state.feedItems.filter((item) => item.type === "alert").length, 1);
  assert.equal(JSON.parse(saved).state.feedItems.find((item: FeedItem) => item.type === "response").usage.scope, "observed-stream");
});

test("stream termination expires only approval items owned by that stream", () => {
  const items: FeedItem[] = [
    {
      id: "approval-1",
      type: "approval-required",
      message: "Approve",
      timestamp: 1,
      approval: {
        decisionCapability: "cap-1",
        toolName: "override_phase",
        riskLevel: "high",
        action: {},
        facts: {},
        expiresAtMs: 60_000,
      },
    },
    {
      id: "approval-2",
      type: "approval-required",
      message: "Other stream",
      timestamp: 2,
      approval: {
        decisionCapability: "cap-2",
        toolName: "override_phase",
        riskLevel: "high",
        action: {},
        facts: {},
        expiresAtMs: 120_000,
      },
    },
  ];

  const closed = closeCtoApprovals(items, new Set(["cap-1"]));
  assert.equal(closed[0].type, "alert");
  assert.equal(closed[0].approval, undefined);
  assert.equal(closed[1].approval?.decisionCapability, "cap-2");
});

test("malformed events cancel the open transport and release its reader", async (t) => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("data: invalid-json\n\n"));
    },
    cancel() { cancelled = true; },
  });
  t.mock.method(globalThis, "fetch", async () => new Response(body, {
    headers: { "content-type": "text/event-stream" },
  }));
  const errors: unknown[][] = [];
  t.mock.method(console, "error", (...args: unknown[]) => { errors.push(args); });
  useOrchestratorStore.setState({ feedItems: [], draft: "" });
  await useOrchestratorStore.getState().sendMessage("request");
  assert.equal(cancelled, true);
  assert.equal(body.locked, false);
  assert.equal(useOrchestratorStore.getState().isProcessing, false);
  assert.match(useOrchestratorStore.getState().feedItems.find((item) => item.type === "response")?.message ?? "", /interrupted/);
  assert.equal(errors.length, 1);
});
