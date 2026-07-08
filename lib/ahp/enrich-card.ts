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
import { buildCoherenceSummary } from "@/lib/orchestrator/coherence-engine";
import {
  getCardStatusHistory,
  recordCardStatus,
} from "@/lib/orchestrator/status-history-store";

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

export interface EnrichOptions {
  /** When false, read/attach status history but don't record the current
   *  activity. Used for cached rehydration so a stale cached activity can't be
   *  written with a fresh timestamp and surface as the card's "current" status. */
  recordStatus?: boolean;
}

export function enrichSessionToCard(
  session: AHPSessionSummary,
  changesetData?: ChangesetEnrichment | null,
  options?: EnrichOptions
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

  // Parked-on-escalation overlay: when the *latest* review run for a skill on the
  // card's current transition is escalated, the heartbeat has parked it for a human
  // — surface `needs-human` or the card would sit here looking idle. Using the
  // latest-per-skill run (reviewRuns are id-DESC) avoids a stale escalation that a
  // later pass already superseded. Precedence: runtime error/needs-human already
  // wins; escalation outranks coherence/stale.
  if (nextPhase && card.attention !== "error" && card.attention !== "needs-human") {
    const transition = `${card.phase}->${nextPhase}`;
    const latestStatusBySkill = new Map<string, string>();
    for (const run of reviewRuns) {
      if (run.phaseTransition !== transition) continue;
      if (!latestStatusBySkill.has(run.skillId)) latestStatusBySkill.set(run.skillId, run.status);
    }
    const parked = [...latestStatusBySkill.values()].some((status) => status === "escalated");
    if (parked) {
      card.attention = "needs-human";
    }
  }

  // Record the current status line and attach the recent trail. Best-effort:
  // a history failure must never break card enrichment.
  try {
    if (options?.recordStatus !== false && card.activity) {
      recordCardStatus(session.resource, card.activity);
    }
    const history = getCardStatusHistory(session.resource, 3);
    if (history.length > 0) {
      card.statusHistory = history;
    }
  } catch (err) {
    console.warn(
      "[status-history] failed to record/read status:",
      err instanceof Error ? err.message : err
    );
  }

  // Board-level coherence: attach confirmed conflicts and (only if a confirmed
  // conflict exists) raise the `conflict` attention overlay. Precedence:
  // error/needs-human (runtime) > conflict > stale > none — so we never mask a
  // runtime attention that already needs the human.
  try {
    const coherence = buildCoherenceSummary(session.resource);
    if (coherence) {
      card.coherence = { conflictsWith: coherence.peers, blocking: coherence.blocking };
      const runtimeCritical = card.attention === "needs-human" || card.attention === "error";
      if (coherence.peers.length > 0 && !runtimeCritical) {
        card.attention = "conflict";
      }
    }
  } catch (err) {
    if (process.env.AHP_DEBUG) {
      console.warn("[coherence] enrichment failed:", err instanceof Error ? err.message : err);
    }
  }

  return card;
}
