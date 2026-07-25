import "server-only";

import { CopilotClient } from "@github/copilot-sdk";

import { ORCHESTRATOR_MODEL } from "./model";
import {
  parsePlanReviewVerdict,
  type PlanReviewVerdict,
} from "./plan-review-core";

let clientInstance: CopilotClient | null = null;
let clientStarting: Promise<CopilotClient> | null = null;

async function getClient(): Promise<CopilotClient> {
  if (clientInstance) return clientInstance;
  if (clientStarting) return clientStarting;

  clientStarting = (async () => {
    try {
      const client = new CopilotClient();
      await client.start();
      clientInstance = client;
      return client;
    } finally {
      clientStarting = null;
    }
  })();
  return clientStarting;
}

async function resetClient(): Promise<void> {
  const old = clientInstance;
  clientInstance = null;
  clientStarting = null;
  if (old) await old.stop().catch(() => {});
}

const SYSTEM_PROMPT = `You are an independent rubber-duck reviewer for a software implementation plan.

Challenge the plan's assumptions, scope, sequencing, edge cases, failure modes, and validation strategy. Assess named files, APIs, types, and integration points only from the supplied plan text; do not claim to have inspected the repository. Do not write code or revise the plan yourself.

Return "failed" only when concrete issues must be addressed before implementation. Suggestions that are useful but non-blocking do not fail the plan. Return "needs-human" when the supplied plan is insufficient to judge.

Respond with ONLY a JSON object:
{"status":"passed|failed|needs-human","summary":"one concise sentence","findings":["concrete blocker 1"]}

"findings" must be non-empty exactly when status is "failed".`;

export async function reviewPlan(planContent: string): Promise<PlanReviewVerdict> {
  if (!planContent.trim()) {
    return {
      status: "needs-human",
      summary: "The plan artifact is empty or unavailable.",
      findings: [],
    };
  }
  if (planContent.length > 60_000) {
    return {
      status: "needs-human",
      summary: "The plan is too large for a complete independent review.",
      findings: [],
    };
  }

  try {
    const client = await getClient();
    const session = await client.createSession({
      model: ORCHESTRATOR_MODEL,
      systemMessage: { content: SYSTEM_PROMPT },
      availableTools: [],
    });

    try {
      const response = await session.sendAndWait(
        { prompt: `Review this implementation plan:\n\n${planContent}` },
        45_000,
      );
      return parsePlanReviewVerdict(response?.data?.content) ?? {
        status: "needs-human",
        summary: "The independent reviewer returned an invalid verdict.",
        findings: [],
      };
    } finally {
      await session.disconnect().catch(() => {});
    }
  } catch (error) {
    await resetClient();
    console.warn(
      "[plan-reviewer] SDK call failed:",
      error instanceof Error ? error.message : error,
    );
    return {
      status: "needs-human",
      summary: "The independent plan reviewer is unavailable.",
      findings: [],
    };
  }
}
