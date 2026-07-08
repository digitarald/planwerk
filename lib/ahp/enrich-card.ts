import "server-only";

import { KanbanCard, ReviewFinding, RiskLevel, Phase } from "@/lib/types";
import {
  canAdvancePhase,
  computeChangesetRef,
  deriveGateStatus,
  getNextPhase,
  getPersistedCardPhase,
  setCardPhase,
  type GateConfig,
} from "@/lib/orchestrator/gate-engine";
import { getCardRisk } from "@/lib/orchestrator/risk-store";
import { getReviewRunsForCard, type ReviewRun } from "@/lib/orchestrator/review-executor";
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

const GATE_LABELS: Record<string, string> = {
  "plan-review": "Plan review",
  "architecture-review": "Architecture review",
  "code-review": "Code review",
  "security-review": "Security review",
};

function gateLabel(gate: GateConfig): string {
  if (gate.gateName && GATE_LABELS[gate.gateName]) return GATE_LABELS[gate.gateName];
  switch (gate.gateType) {
    case "lint":
      return "Lint";
    case "typecheck":
      return "Typecheck";
    case "test":
      return "Tests";
    case "human-approval":
      return "Human approval";
    default:
      return gate.gateName ?? gate.gateType;
  }
}

/**
 * Human-readable reason a card can't yet advance, for the legibility surface.
 * Returns undefined when the transition is already satisfied (nothing to show).
 * Annotates review gates with their latest run state so a card that has *started*
 * a review reads differently from one that never began. Escalated reviews are
 * intentionally left to the `needs-human` attention overlay, not duplicated here.
 */
function computeGateBlocker(
  cardId: string,
  fromPhase: Phase,
  toPhase: Phase,
  riskLevel: RiskLevel | undefined,
  reviewRuns: ReviewRun[],
  transition: string,
  changesetRef?: string
): string | undefined {
  const { allowed, pendingGates } = canAdvancePhase(
    cardId,
    fromPhase,
    toPhase,
    undefined,
    riskLevel,
    changesetRef
  );
  if (allowed || pendingGates.length === 0) return undefined;

  const latestBySkill = new Map<string, string>();
  for (const run of reviewRuns) {
    if (run.phaseTransition !== transition) continue;
    if (!latestBySkill.has(run.skillId)) latestBySkill.set(run.skillId, run.status);
  }

  if (pendingGates.length === 1) {
    const gate = pendingGates[0];
    const label = gateLabel(gate);
    if (gate.gateType === "review" && gate.gateName) {
      const status = latestBySkill.get(gate.gateName);
      if (!status) return `${label} not started`;
      if (status === "failed") return `${label} failed — retrying`;
      if (status === "injected" || status === "pending" || status === "extracting") {
        return `${label} in progress`;
      }
    }
    return `${label} pending`;
  }

  const labels = pendingGates.map(gateLabel);
  return `Blocked on ${labels.length} gates: ${labels.join(", ")}`;
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
  // Freshness ref for the *display* gate status/blocker — must match what the
  // heartbeat uses so the rendered verdict agrees with what the orchestrator will
  // do. Plan→build gates key on the plan content; other transitions key on the
  // code diff, but only when it's session-scoped (verified). An unverified diff
  // (shared working-tree summary) → undefined ("unknown"), which never reads a
  // passing gate as stale.
  const changesetRef =
    card.phase === "plan"
      ? card.planContentHash
      : card.changesetVerified
        ? computeChangesetRef(
            card.filesChanged,
            card.additions,
            card.deletions,
            card.modifiedAt
          )
        : undefined;
  if (nextPhase) {
    card.gateStatus = deriveGateStatus(session.resource, card.phase, nextPhase, storedRisk?.level, changesetRef);
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

  // Legibility: when the gate is silently `pending` (no badge/spinner), surface
  // *why* the card can't advance so a busy card producing work doesn't look
  // mysteriously stuck. Purely informational — does not move the card.
  if (nextPhase && card.gateStatus === "pending") {
    card.gateBlocker = computeGateBlocker(
      session.resource,
      card.phase,
      nextPhase,
      storedRisk?.level,
      reviewRuns,
      `${card.phase}->${nextPhase}`,
      changesetRef
    );
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
