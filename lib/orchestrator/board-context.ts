import "server-only";

import { getDb } from "@/lib/db/schema";
import type { KanbanCard, Phase } from "@/lib/types";

/**
 * Build a compact board context string for the LLM orchestrator's system prompt.
 * Keeps token usage minimal while providing actionable context.
 */
export function buildBoardContext(cards: KanbanCard[]): string {
  const phases: Record<Phase, KanbanCard[]> = {
    define: [],
    plan: [],
    build: [],
    review: [],
    ship: [],
  };

  for (const card of cards) {
    if (!card.isArchived) {
      phases[card.phase].push(card);
    }
  }

  const sections: string[] = [];

  // Phase summary
  const phaseCounts = Object.entries(phases)
    .map(([phase, cards]) => `${phase}: ${cards.length}`)
    .join(", ");
  sections.push(`## Board: ${phaseCounts}`);

  // Cards needing attention
  const attentionCards = cards.filter(
    (c) => !c.isArchived && (c.attention !== "none" || c.runtime === "error" || c.runtime === "input-needed")
  );
  if (attentionCards.length > 0) {
    sections.push("## Needs Attention");
    for (const card of attentionCards.slice(0, 5)) {
      const reasons: string[] = [];
      if (card.runtime === "error") reasons.push("error");
      if (card.runtime === "input-needed") reasons.push("input-needed");
      if (card.attention === "needs-human") reasons.push("needs-human");
      if (card.attention === "stale") reasons.push("stale");
      sections.push(`- **${card.title}** [${card.phase}] — ${reasons.join(", ")}`);
    }
  }

  // Active cards with risk
  const riskCards = cards.filter((c) => !c.isArchived && c.risk && c.risk !== "low");
  if (riskCards.length > 0) {
    sections.push("## Risk");
    for (const card of riskCards.slice(0, 5)) {
      sections.push(`- **${card.title}** — ${card.risk} risk${card.riskFactors?.length ? `: ${card.riskFactors.join(", ")}` : ""}`);
    }
  }

  // Recently active
  const recentCards = cards
    .filter((c) => !c.isArchived && c.runtime === "running")
    .slice(0, 3);
  if (recentCards.length > 0) {
    sections.push("## Running");
    for (const card of recentCards) {
      sections.push(`- **${card.title}** [${card.phase}] — ${card.activity || "active"}`);
    }
  }

  return sections.join("\n\n");
}

/**
 * Build the selected card detail for focused questions.
 */
export function buildCardDetail(card: KanbanCard): string {
  const lines: string[] = [
    `## Selected: ${card.title}`,
    `Phase: ${card.phase} | Runtime: ${card.runtime} | Gate: ${card.gateStatus}`,
  ];

  if (card.risk) lines.push(`Risk: ${card.risk}${card.riskFactors?.length ? ` (${card.riskFactors.join(", ")})` : ""}`);
  if (card.activity) lines.push(`Activity: ${card.activity}`);
  if (card.branch) lines.push(`Branch: ${card.branch}`);
  if (card.filesChanged) lines.push(`Changes: +${card.additions}/-${card.deletions} in ${card.filesChanged} files`);
  if (card.planSteps) lines.push(`Plan: ${card.planSteps.done}/${card.planSteps.total} steps`);
  if (card.lastAgentMessage) {
    lines.push(`Last message: ${card.lastAgentMessage.slice(0, 300)}`);
  }
  if (card.pendingInput) {
    lines.push(`Pending input: ${card.pendingInput.questions.map(q => q.title).join("; ").slice(0, 200)}`);
  }

  return lines.join("\n");
}

/**
 * Get gate status summary from the database for the system prompt.
 */
export function getGateSummary(): string {
  const db = getDb();
  const running = db
    .prepare("SELECT COUNT(*) as count FROM gate_runs WHERE status = 'running'")
    .get() as { count: number };
  const recentFailed = db
    .prepare(
      "SELECT card_id, gate_name, output FROM gate_runs WHERE status = 'failed' ORDER BY completed_at DESC LIMIT 3"
    )
    .all() as Array<{ card_id: string; gate_name: string | null; output: string | null }>;

  const lines: string[] = [];
  if (running.count > 0) {
    lines.push(`${running.count} gate(s) currently running.`);
  }
  if (recentFailed.length > 0) {
    lines.push("Recent failures:");
    for (const f of recentFailed) {
      lines.push(`- ${f.card_id}: ${f.gate_name ?? "unknown"}`);
    }
  }
  return lines.join("\n");
}
