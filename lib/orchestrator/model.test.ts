import assert from "node:assert/strict";
import { test } from "node:test";

import type { ModelInfo } from "@github/copilot-sdk";

import { selectOrchestratorModel } from "./model.ts";

function model(
  id: string,
  options: {
    context?: number;
    reasoning?: boolean;
    efforts?: ModelInfo["supportedReasoningEfforts"];
    state?: "enabled" | "disabled" | "unconfigured";
  } = {}
): ModelInfo {
  return {
    id,
    name: id,
    capabilities: {
      supports: {
        vision: false,
        reasoningEffort: options.reasoning ?? false,
      },
      limits: {
        max_context_window_tokens: options.context ?? 100,
      },
    },
    policy: options.state
      ? { state: options.state, terms: "" }
      : undefined,
    supportedReasoningEfforts: options.efforts,
  };
}

test("model policy uses only runtime-discovered enabled models", async () => {
  const client = {
    listModels: async () => [
      model("small", { context: 100 }),
      model("large", { context: 200 }),
      model("disabled", { context: 1_000, state: "disabled" }),
    ],
  };
  assert.deepEqual(
    await selectOrchestratorModel(client, {
      role: "conversation",
      override: "",
    }),
    {
      model: "large",
      reasoningEffort: undefined,
      role: "conversation",
      highStakes: false,
      source: "policy",
    }
  );
});

test("explicit override is validated for availability and high-stakes capability", async () => {
  const client = {
    listModels: async () => [
      model("routine"),
      model("reviewer", {
        reasoning: true,
        efforts: ["medium", "high"],
      }),
    ],
  };

  await assert.rejects(
    selectOrchestratorModel(client, {
      role: "conversation",
      override: "missing",
    }),
    /unavailable or disabled/
  );
  await assert.rejects(
    selectOrchestratorModel(client, {
      role: "review",
      override: "routine",
    }),
    /lacks reasoning capability/
  );
  assert.deepEqual(
    await selectOrchestratorModel(client, {
      role: "review",
      override: "reviewer",
    }),
    {
      model: "reviewer",
      reasoningEffort: "high",
      role: "review",
      highStakes: true,
      source: "override",
    }
  );
});

test("high-stakes policy fails closed instead of selecting a weaker model", async () => {
  const client = {
    listModels: async () => [model("routine")],
  };
  await assert.rejects(
    selectOrchestratorModel(client, {
      role: "approval",
      override: "",
    }),
    /No enabled reasoning-capable model/
  );
});
