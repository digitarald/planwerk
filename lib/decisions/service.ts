import "server-only";

import { createHash } from "node:crypto";
import { getDb } from "../db/schema.ts";
import { stableJson } from "../db/cto-continuity-store.ts";
import { readDecision, writeDecision } from "../db/decision-store.ts";
import { AssessmentLane } from "../orchestrator/assessment-lane.ts";
import { awaitAbortable } from "../abort.ts";
import { acceptanceReason, validateQuestions, type DecisionFamily, type DecisionOutcome, type DecisionQuestions } from "./core.ts";
import { decisionPolicyKey, decisionProfile } from "./config.ts";
import { callFoundry, DecisionTransportError } from "./transport.ts";

export { decisionChoice } from "./core.ts";
export { decisionPolicyKey, decisionProfile, decisionStillCurrent } from "./config.ts";
export type { DecisionOutcome, DecisionQuestions } from "./core.ts";

const lane = new AssessmentLane<DecisionOutcome>(2, 128);

export async function decide(
  family: DecisionFamily,
  version: string,
  state: unknown,
  questions: DecisionQuestions,
  options: { hostUrl?: string; owner?: string; signal?: AbortSignal } = {},
): Promise<DecisionOutcome> {
  validateQuestions(questions);
  const profile = decisionProfile(family);
  const policyKey = decisionPolicyKey(family, version);
  const owner = JSON.stringify([options.hostUrl ?? "local", options.owner ?? family]);
  const key = createHash("sha256").update(stableJson([owner, policyKey, state, questions])).digest("hex");
  if (profile.mode === "legacy") throw new Error("Decision inference cannot run in legacy mode.");
  options.signal?.throwIfAborted();
  const cached = readDecision(getDb(), key);
  if (cached && (cached.kind !== "deferred" || (cached.retryAt ?? Infinity) > Date.now())) return cached;
  if (profile.mode === "active" && !profile.acceptance) {
    const outcome: DecisionOutcome = { key, policyKey, kind: "needs-human",
      reason: "Active decisions require a validated acceptance profile.", latencyMs: 0 };
    writeDecision(getDb(), family, owner, outcome);
    return outcome;
  }

  // Inference is shared, but cancellation and authority belong to each caller.
  const outcome = await awaitAbortable(() => lane.run(owner, key, async () => {
    const start = performance.now();
    const attempts = (cached?.attempts ?? 0) + 1;
    let result: DecisionOutcome;
    try {
      const response = await callFoundry(state, questions);
      const reason = acceptanceReason(response, profile.acceptance);
      result = { key, policyKey, kind: reason ? "needs-human" : "accepted", reason, response, latencyMs: performance.now() - start };
    } catch (error) {
      const retryAfter = error instanceof DecisionTransportError ? error.retryAfterMs
        : error instanceof TypeError || (error instanceof Error && error.name === "TimeoutError") ? 30_000 : undefined;
      const message = error instanceof DecisionTransportError ? error.message
        : error instanceof Error && /setup|Configure|requires a deployment|exceeds/.test(error.message) ? error.message
        : "Decision request failed or returned invalid output.";
      console.warn(`[decisions:${family}] ${message}`);
      result = { key, policyKey, kind: retryAfter ? "deferred" : "needs-human", reason: message,
        latencyMs: performance.now() - start, retryAt: retryAfter ? Date.now() + retryAfter : undefined };
    }
    result.attempts = attempts;
    if (result.kind === "deferred" && attempts >= 3) {
      result = { ...result, kind: "needs-human", retryAt: undefined,
        reason: "Decision-provider retry budget exhausted; inspect setup before changing the configuration revision to retry." };
    }
    writeDecision(getDb(), family, owner, result);
    return result;
  }), options.signal);
  if (decisionPolicyKey(family, version) !== policyKey) {
    return { ...outcome, kind: "deferred", reason: "Decision policy changed during inference." };
  }
  return outcome;
}

export function scheduleShadow(
  family: DecisionFamily, version: string, state: unknown, questions: DecisionQuestions,
  options: { hostUrl?: string; owner?: string } = {},
): void {
  void decide(family, version, state, questions, options).catch((error) => {
    console.warn(`[decisions:${family}] Shadow evaluation failed:`, error instanceof Error ? error.message : "unknown failure");
  });
}
