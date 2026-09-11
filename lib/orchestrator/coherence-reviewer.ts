import "server-only";

import type { CopilotClient } from "@github/copilot-sdk";
import { randomUUID } from "node:crypto";

import type { CoherenceTier } from "@/lib/types";
import { getRiskForAutomation } from "./risk-store";
import { effectiveRisk } from "./coherence-detect";
import {
  disposeOneShotSession,
  invalidateRuntimeForCleanupFailure,
  releaseRuntimeLease,
} from "./copilot-session";
import {
  claimForReviewOwner,
  completeReview,
  renewCoherenceReviewLease,
  type CoherenceRow,
} from "./coherence-engine";
import { WORK_LEASE_MS } from "@/lib/db/work-lease-schema";
import { fetchOverlapContent, type CardOverlapContent } from "./coherence-content";
import { selectOrchestratorModel } from "./model";
import {
  acquireCopilotRuntimeClient,
  classifyCopilotFailure,
} from "./sdk-runtime";
import type { CopilotRuntimeLease } from "./sdk-runtime-manager";

/** Per-card context the reviewer needs beyond what the DB row carries. */
export interface ReviewCardCtx {
  id: string;
  title: string;
  planContent?: string;
  lastAgentMessage?: string;
}

export interface CoherenceReviewOutcome {
  rowId: number;
  cardA: string;
  cardB: string;
  status: "conflict" | "coherent" | "needs-human";
  summary: string;
}

/** How many pairs a single executor pass will review — bounds LLM cost per tick. */
const MAX_REVIEWS_PER_PASS = 2;

const SYSTEM_PROMPT = `You are a coherence reviewer for a system that runs multiple AI coding agents in parallel on the same repository.

Two concurrent, independent agent sessions ("Card A" and "Card B") have both edited overlapping code. Each was correct in isolation, but they never saw each other's work. Your job is to judge whether their changes will COHERE (integrate cleanly) or CONFLICT (clash, contradict, or drift architecturally) when both land.

Look for:
- Direct edit collisions on the same functions/exports/types.
- Contradictory approaches to the same problem (e.g. two different implementations of one interface).
- One card removing/renaming something the other still depends on.
- Divergent architectural decisions (naming, patterns, data shapes) that would produce an incoherent whole.

Do NOT flag two edits to the same file that touch unrelated regions and compose fine — overlap alone is not conflict.

Respond with ONLY a JSON object (no markdown fences):
{"status": "coherent" | "conflict" | "needs-human", "summary": "one sentence", "findings": ["specific clash 1", "..."]}

Use "conflict" only when there is a concrete clash. Use "needs-human" when the provided evidence is insufficient to judge. "findings" should be empty for "coherent".`;

function renderCardContent(label: string, ctx: ReviewCardCtx, content: CardOverlapContent): string {
  const lines = [`### ${label}: ${ctx.title}`];
  if (ctx.planContent) lines.push(`Plan:\n${ctx.planContent.slice(0, 1500)}`);
  if (ctx.lastAgentMessage) lines.push(`Last agent message:\n${ctx.lastAgentMessage.slice(0, 800)}`);
  if (content.failed || content.files.length === 0) {
    lines.push("(no file content available — degraded evidence)");
  } else {
    for (const f of content.files) {
      lines.push(`File \`${f.path}\`${f.truncated ? " (truncated)" : ""}:\n\`\`\`\n${f.content}\n\`\`\``);
    }
  }
  return lines.join("\n\n");
}

function buildPrompt(
  tier: CoherenceTier,
  overlapPaths: string[],
  a: ReviewCardCtx,
  b: ReviewCardCtx,
  aContent: CardOverlapContent,
  bContent: CardOverlapContent
): string {
  const overlap =
    tier === "file"
      ? `Shared files:\n${overlapPaths.map((p) => `  - ${p}`).join("\n")}`
      : `Shared module directories:\n${overlapPaths.map((p) => `  - ${p}`).join("\n")}`;
  return [
    `Overlap tier: ${tier}`,
    overlap,
    renderCardContent("Card A", a, aContent),
    renderCardContent("Card B", b, bContent),
  ].join("\n\n");
}

type Verdict = { status: "conflict" | "coherent" | "needs-human"; summary: string; findings: string[] };

function parseVerdict(content: string): Verdict | null {
  try {
    const cleaned = content.replace(/```(?:json)?\s*/g, "").replace(/```\s*$/g, "").trim();
    const parsed = JSON.parse(cleaned);
    if (
      parsed &&
      ["coherent", "conflict", "needs-human"].includes(parsed.status) &&
      typeof parsed.summary === "string"
    ) {
      return {
        status: parsed.status,
        summary: parsed.summary,
        findings: Array.isArray(parsed.findings) ? parsed.findings.map(String) : [],
      };
    }
  } catch {
    // fall through
  }
  return null;
}

function highRiskInvolved(cardA: string, cardB: string): boolean {
  const a = effectiveRisk(getRiskForAutomation(cardA));
  const b = effectiveRisk(getRiskForAutomation(cardB));
  return a === "high" || b === "high";
}

async function reviewPair(
  hostUrl: string,
  row: CoherenceRow,
  ctxById: Map<string, ReviewCardCtx>
): Promise<{ status: "conflict" | "coherent" | "needs-human"; summary: string; findings: string[] }> {
  const a = ctxById.get(row.cardA) ?? { id: row.cardA, title: row.cardA };
  const b = ctxById.get(row.cardB) ?? { id: row.cardB, title: row.cardB };

  const [aContent, bContent] = await Promise.all([
    fetchOverlapContent(hostUrl, row.cardA, row.tier, row.overlapPaths),
    fetchOverlapContent(hostUrl, row.cardB, row.tier, row.overlapPaths),
  ]);

  // Fail-safe: if we couldn't read code for a high-risk pair, don't judge on thin
  // evidence — keep it blocked as needs-human.
  if ((aContent.failed || bContent.failed) && highRiskInvolved(row.cardA, row.cardB)) {
    return {
      status: "needs-human",
      summary: "Could not read overlapping code for a high-risk pair; needs human review.",
      findings: [],
    };
  }

  let client: CopilotClient | undefined;
  let runtimeLease: CopilotRuntimeLease<CopilotClient> | undefined;
  try {
    runtimeLease = await acquireCopilotRuntimeClient();
    client = runtimeLease.client;
    const selectedModel = await selectOrchestratorModel(client, {
      role: "review",
      risk: highRiskInvolved(row.cardA, row.cardB) ? "high" : "medium",
    });
    const session = await client.createSession({
      model: selectedModel.model,
      reasoningEffort: selectedModel.reasoningEffort,
      systemMessage: { content: SYSTEM_PROMPT },
      availableTools: [],
      skipCustomInstructions: true,
    });
    let responseCompleted = false;
    try {
      const response = await session.sendAndWait(
        { prompt: buildPrompt(row.tier, row.overlapPaths, a, b, aContent, bContent) },
        45_000
      );
      responseCompleted = true;
      const content = response?.data?.content;
      const parsed = content ? parseVerdict(content) : null;
      if (parsed) return parsed;
    } finally {
      const cleanup = await disposeOneShotSession(
        client,
        session,
        !responseCompleted,
        "[coherence-reviewer]"
      );
      await invalidateRuntimeForCleanupFailure(
        runtimeLease,
        cleanup,
        "[coherence-reviewer]",
      );
    }
  } catch (err) {
    if (runtimeLease && classifyCopilotFailure(err) === "transport") {
      await runtimeLease.invalidate(err).catch((resetError) => {
      console.warn(
        "[coherence-reviewer] Failed to reset Copilot SDK runtime:",
        resetError instanceof Error ? resetError.message : resetError
      );
      });
    }
    console.warn(
      "[coherence-reviewer] SDK call failed:",
      err instanceof Error ? err.message : err
    );
  } finally {
    await releaseRuntimeLease(runtimeLease, "[coherence-reviewer]");
  }

  // Reviewer unavailable → don't fabricate a verdict; defer to human.
  return {
    status: "needs-human",
    summary: "Coherence reviewer unavailable; needs human review.",
    findings: [],
  };
}

/**
 * Async executor: claims detected pairs (CAS), reviews them off the heartbeat
 * tick, and writes race-safe verdicts. Bounded per pass to cap LLM cost. The
 * heartbeat kicks this fire-and-forget — it must never be awaited inside runTick.
 */
export async function runCoherenceExecutor(
  hostUrl: string,
  rows: CoherenceRow[],
  ctxById: Map<string, ReviewCardCtx>
): Promise<CoherenceReviewOutcome[]> {
  const outcomes: CoherenceReviewOutcome[] = [];
  let reviewed = 0;

  for (const row of rows) {
    if (reviewed >= MAX_REVIEWS_PER_PASS) break;
    // CAS-claim: only the winner proceeds; skips if signature changed meanwhile.
    const ownerId = randomUUID();
    if (!claimForReviewOwner(row.id, row.signature, ownerId)) continue;
    reviewed++;

    const renewal = setInterval(() => {
      renewCoherenceReviewLease(row.id, row.signature, ownerId);
    }, Math.max(1, Math.floor(WORK_LEASE_MS / 3)));
    renewal.unref();
    let verdict;
    try {
      verdict = await reviewPair(hostUrl, row, ctxById);
    } finally {
      clearInterval(renewal);
    }
    const applied = completeReview(
      row.id,
      row.signature,
      verdict,
      ownerId,
    );
    if (applied) {
      outcomes.push({
        rowId: row.id,
        cardA: row.cardA,
        cardB: row.cardB,
        status: verdict.status,
        summary: verdict.summary,
      });
    }
  }

  return outcomes;
}
