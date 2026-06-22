import "server-only";

import { KanbanCard, ReviewFinding } from "@/lib/types";
import {
  deriveGateStatus,
  getNextPhase,
  getPersistedCardPhase,
  setCardPhase,
} from "@/lib/orchestrator/gate-engine";
import { getCardRisk } from "@/lib/orchestrator/risk-store";
import { getReviewRunsForCard } from "@/lib/orchestrator/review-executor";

import { mapSessionToCard } from "./map-session";
import { AHPSessionSummary } from "./types";
import type { ChangesetEnrichment } from "./changeset-enricher";

function safeParseJson(json: string): string[] | undefined {
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.map(String) : undefined;
  } catch {
    return undefined;
  }
}

export function enrichSessionToCard(
  session: AHPSessionSummary,
  changesetData?: ChangesetEnrichment | null
): KanbanCard {
  const persistedPhase = getPersistedCardPhase(session.resource);
  const storedRisk = getCardRisk(session.resource);
  const card = mapSessionToCard(session, persistedPhase, changesetData, storedRisk?.level);

  // Sync DB when inference overrides the persisted phase (e.g. archived+code → ship)
  if (card.phase !== persistedPhase) {
    setCardPhase(session.resource, card.phase);
  }

  if (storedRisk?.factors.length) {
    card.riskFactors = storedRisk.factors;
  }

  const nextPhase = getNextPhase(card.phase);
  if (nextPhase) {
    card.gateStatus = deriveGateStatus(session.resource, card.phase, nextPhase, storedRisk?.level);
  }

  // Attach review findings from DB
  const reviewRuns = getReviewRunsForCard(session.resource);
  if (reviewRuns.length > 0) {
    card.reviewFindings = reviewRuns.slice(0, 10).map((run): ReviewFinding => ({
      id: String(run.id),
      skillId: run.skillId,
      status: run.status === "pending" || run.status === "injected" || run.status === "extracting"
        ? "in-progress"
        : run.status as "passed" | "failed" | "escalated",
      iteration: run.iteration,
      maxIterations: run.maxIterations,
      summary: run.verdictSummary ?? undefined,
      findings: run.findingsJson ? safeParseJson(run.findingsJson) : undefined,
    }));
  }

  return card;
}
