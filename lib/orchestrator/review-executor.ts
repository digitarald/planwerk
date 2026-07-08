import "server-only";

import { getDb } from "@/lib/db/schema";
import { injectMessage, fetchLastTurns } from "@/lib/ahp/session-messenger";
import {
  loadConfig,
  getApplicableSkills,
  getEffectiveMaxIterations,
  shouldFollowEdits,
  type SkillConfig,
} from "./skill-config";
import { extractVerdict, type ReviewVerdict } from "./verdict-extractor";
import {
  startGateRun,
  completeGateRun,
} from "./gate-engine";
import type { Phase, RiskLevel } from "@/lib/types";
import { normalizeChangesetRef } from "@/lib/types";

export type ReviewRunStatus =
  | "pending"
  | "injected"
  | "extracting"
  | "passed"
  | "failed"
  | "escalated";

export interface ReviewRun {
  id: number;
  cardId: string;
  skillId: string;
  phaseTransition: string;
  status: ReviewRunStatus;
  iteration: number;
  maxIterations: number;
  promptInjectedAt: string | null;
  verdictExtractedAt: string | null;
  verdictSummary: string | null;
  findingsJson: string | null;
  gateRunId: number | null;
  changesetRef: string | null;
}

interface ReviewRunRow {
  id: number;
  card_id: string;
  skill_id: string;
  phase_transition: string;
  status: string;
  iteration: number;
  max_iterations: number;
  prompt_injected_at: string | null;
  verdict_extracted_at: string | null;
  verdict_summary: string | null;
  findings_json: string | null;
  gate_run_id: number | null;
  changeset_ref: string | null;
}

function mapRow(row: ReviewRunRow): ReviewRun {
  return {
    id: row.id,
    cardId: row.card_id,
    skillId: row.skill_id,
    phaseTransition: row.phase_transition,
    status: row.status as ReviewRunStatus,
    iteration: row.iteration,
    maxIterations: row.max_iterations,
    promptInjectedAt: row.prompt_injected_at,
    verdictExtractedAt: row.verdict_extracted_at,
    verdictSummary: row.verdict_summary,
    findingsJson: row.findings_json,
    gateRunId: row.gate_run_id,
    changesetRef: row.changeset_ref,
  };
}

/**
 * Get active review runs for a card (not in terminal state).
 */
export function getActiveReviewRuns(cardId: string): ReviewRun[] {
  const db = getDb();
  const rows = db
    .prepare(
      "SELECT * FROM review_runs WHERE card_id = ? AND status NOT IN ('passed', 'escalated') ORDER BY id DESC"
    )
    .all(cardId) as ReviewRunRow[];
  return rows.map(mapRow);
}

/**
 * Get all review runs for a card (including completed).
 */
export function getReviewRunsForCard(cardId: string): ReviewRun[] {
  const db = getDb();
  const rows = db
    .prepare("SELECT * FROM review_runs WHERE card_id = ? ORDER BY id DESC")
    .all(cardId) as ReviewRunRow[];
  return rows.map(mapRow);
}

/**
 * The most recent review run for a (card, skill, transition), or null. Rows are
 * keyed by ascending id, so the highest id is the latest attempt.
 */
export function getLatestReviewRun(
  cardId: string,
  skillId: string,
  phaseTransition: string
): ReviewRun | null {
  const db = getDb();
  const row = db
    .prepare(
      "SELECT * FROM review_runs WHERE card_id = ? AND skill_id = ? AND phase_transition = ? ORDER BY id DESC LIMIT 1"
    )
    .get(cardId, skillId, phaseTransition) as ReviewRunRow | undefined;
  return row ? mapRow(row) : null;
}

/**
 * Whether a review skill should be (re)started for a transition.
 *
 * Skips a skill whose latest run is a *fresh* terminal outcome:
 *  - `passed`    → the gate is already satisfied for this changeset.
 *  - `escalated` → parked for a human; re-injecting would restart the churn.
 * A terminal run recorded against a *different* changeset (the reviewed diff has
 * since changed) is stale, so we return `true` to re-review the new changes.
 * When no run exists yet, returns `true` (first review).
 */
export function shouldStartReview(
  cardId: string,
  skillId: string,
  phaseTransition: string,
  currentChangesetRef?: string
): boolean {
  const latest = getLatestReviewRun(cardId, skillId, phaseTransition);
  if (!latest) return true;
  const terminal = latest.status === "passed" || latest.status === "escalated";
  if (!terminal) return true;
  const fresh = normalizeChangesetRef(latest.changesetRef ?? undefined) === normalizeChangesetRef(currentChangesetRef);
  return !fresh;
}

/** Skill ID used to record a forced plan rubber-duck pass. */
const PLAN_REVIEW_SKILL = "plan-review";

/**
 * Whether this card's plan has already been rubber-ducked once. Used to force
 * a single plan revision on un-reviewed plans without looping.
 */
export function hasPlanRubberDuck(cardId: string): boolean {
  const db = getDb();
  const row = db
    .prepare(
      "SELECT 1 FROM review_runs WHERE card_id = ? AND skill_id = ? LIMIT 1"
    )
    .get(cardId, PLAN_REVIEW_SKILL) as { 1: number } | undefined;
  return row !== undefined;
}

/**
 * Record that a forced plan rubber-duck was injected for a card. Stored as a
 * terminal `passed` review run so it is not re-processed by the review machinery.
 */
export function recordPlanRubberDuck(cardId: string): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO review_runs (card_id, skill_id, phase_transition, status, iteration, max_iterations, verdict_summary, prompt_injected_at, verdict_extracted_at)
     VALUES (?, ?, 'plan->build', 'passed', 1, 1, 'Forced rubber-duck of un-reviewed plan', datetime('now'), datetime('now'))`
  ).run(cardId, PLAN_REVIEW_SKILL);
}

/**
 * Check if a card has all required review gates passing for a transition.
 */
export function hasPassingReviews(
  cardId: string,
  phaseTransition: string,
  riskLevel: RiskLevel
): boolean {
  const skills = getApplicableSkills(phaseTransition, riskLevel);
  if (skills.length === 0) return true;

  const db = getDb();
  // Only consider required skills from gate config
  const config = loadConfig();
  const key = phaseTransition.replace("->", "-to-");
  const gateConfig = config.gates[key] ?? config.gates[phaseTransition];
  if (!gateConfig) return true;

  const requiredSkillIds = gateConfig.required
    .filter((ref): ref is { type: "review"; skill: string } => ref.type === "review")
    .map((ref) => ref.skill);

  for (const skillId of requiredSkillIds) {
    const passingRun = db
      .prepare(
        "SELECT id FROM review_runs WHERE card_id = ? AND skill_id = ? AND phase_transition = ? AND status = 'passed' ORDER BY id DESC LIMIT 1"
      )
      .get(cardId, skillId, phaseTransition) as { id: number } | undefined;

    if (!passingRun) return false;
  }

  return true;
}

/**
 * Start a review skill execution for a card.
 * Creates a review_run record and injects the review prompt into the AHP session.
 */
export async function startReview(
  hostUrl: string,
  sessionUri: string,
  cardId: string,
  skill: SkillConfig,
  phaseTransition: string,
  riskLevel: RiskLevel,
  changesetRef?: string
): Promise<{ reviewRunId: number; success: boolean }> {
  const db = getDb();
  const maxIterations = getEffectiveMaxIterations(skill.id, riskLevel);

  // Atomic claim: check for existing active run AND for an already-injected run
  // to prevent heartbeat/chat race creating duplicates
  const existing = db
    .prepare(
      "SELECT id, iteration, status FROM review_runs WHERE card_id = ? AND skill_id = ? AND status NOT IN ('passed', 'escalated') ORDER BY id DESC LIMIT 1"
    )
    .get(cardId, skill.id) as { id: number; iteration: number; status: string } | undefined;

  // If already injected/pending/extracting, don't double-inject
  if (existing && (existing.status === "injected" || existing.status === "pending" || existing.status === "extracting")) {
    return { reviewRunId: existing.id, success: true };
  }

  let reviewRunId: number;
  let iteration: number;

  if (existing) {
    // Re-inject for existing failed run (next iteration)
    reviewRunId = existing.id;
    iteration = existing.iteration + 1;

    if (iteration > maxIterations) {
      db.prepare(
        "UPDATE review_runs SET status = 'escalated', verdict_summary = 'Max iterations reached' WHERE id = ?"
      ).run(reviewRunId);
      return { reviewRunId, success: false };
    }

    db.prepare(
      "UPDATE review_runs SET status = 'injected', iteration = ?, prompt_injected_at = datetime('now'), changeset_ref = ? WHERE id = ?"
    ).run(iteration, changesetRef ?? null, reviewRunId);
  } else {
    // Create new review run
    const result = db
      .prepare(
        `INSERT INTO review_runs (card_id, skill_id, phase_transition, status, iteration, max_iterations, changeset_ref)
         VALUES (?, ?, ?, 'pending', 1, ?, ?)`
      )
      .run(cardId, skill.id, phaseTransition, maxIterations, changesetRef ?? null);
    reviewRunId = Number(result.lastInsertRowid);
    iteration = 1;
  }

  // Also create a corresponding gate_run record for gate-engine integration
  const [fromPhase, toPhase] = phaseTransition.split("->") as [Phase, Phase];
  const gateRunId = startGateRun(cardId, fromPhase, toPhase, "review", skill.id, changesetRef);
  db.prepare("UPDATE review_runs SET gate_run_id = ? WHERE id = ?").run(gateRunId, reviewRunId);

  // Inject the review prompt into the session (failure-safe: always terminalize on error)
  const prompt = buildReviewPrompt(skill, iteration, maxIterations);
  try {
    const { success } = await injectMessage(hostUrl, sessionUri, prompt);

    if (success) {
      db.prepare(
        "UPDATE review_runs SET status = 'injected', prompt_injected_at = datetime('now') WHERE id = ?"
      ).run(reviewRunId);
    } else {
      db.prepare("UPDATE review_runs SET status = 'failed', verdict_summary = 'Failed to inject prompt' WHERE id = ?").run(reviewRunId);
      completeGateRun(gateRunId, "failed", "Failed to inject review prompt into session");
    }

    return { reviewRunId, success };
  } catch (err) {
    // Ensure DB rows don't get stuck in pending/running state
    db.prepare("UPDATE review_runs SET status = 'failed', verdict_summary = ? WHERE id = ?").run(
      `Injection error: ${err instanceof Error ? err.message : String(err)}`,
      reviewRunId
    );
    completeGateRun(gateRunId, "failed", "Exception during prompt injection");
    return { reviewRunId, success: false };
  }
}

/**
 * Process a review after the session goes idle.
 * Extracts the verdict and decides whether to pass, re-iterate, or escalate.
 */
export async function processReviewResult(
  hostUrl: string,
  sessionUri: string,
  reviewRunId: number,
  currentChangesetRef?: string
): Promise<ReviewVerdict & { action: "passed" | "re-iterate" | "escalated" }> {
  const db = getDb();
  const row = db
    .prepare("SELECT * FROM review_runs WHERE id = ?")
    .get(reviewRunId) as ReviewRunRow | undefined;

  if (!row) {
    return {
      status: "needs-human",
      summary: "Review run not found",
      findings: [],
      madeEdits: false,
      action: "escalated",
    };
  }

  const run = mapRow(row);

  // Mark as extracting
  db.prepare("UPDATE review_runs SET status = 'extracting' WHERE id = ?").run(reviewRunId);

  // Fetch recent turns to extract verdict
  const { turns } = await fetchLastTurns(hostUrl, sessionUri, 5);
  const verdict = extractVerdict(turns);

  // Store verdict
  db.prepare(
    `UPDATE review_runs SET
      verdict_extracted_at = datetime('now'),
      verdict_summary = ?,
      findings_json = ?,
      changeset_ref = ?
    WHERE id = ?`
  ).run(
    verdict.summary,
    JSON.stringify(verdict.findings),
    currentChangesetRef ?? null,
    reviewRunId
  );

  // Decide action based on verdict
  if (verdict.status === "passed") {
    // Even an explicit pass respects the follow-edits policy: at risk levels that
    // require re-review after auto-fixes (high risk), a pass that also made edits
    // is re-iterated once (budget permitting) rather than trusting a self-verified
    // pass. Low/medium (followEdits=false) pass immediately.
    const cfgPass = loadConfig();
    const riskPass = guessRiskFromPhaseTransition(run.cardId);
    if (
      verdict.madeEdits &&
      shouldFollowEdits(riskPass, cfgPass) &&
      run.iteration < getEffectiveMaxIterations(run.skillId, riskPass, cfgPass)
    ) {
      db.prepare("UPDATE review_runs SET status = 'failed' WHERE id = ?").run(reviewRunId);
      if (run.gateRunId) {
        completeGateRun(run.gateRunId, "failed", "Fixes applied — re-review required at this risk level.");
      }
      return { ...verdict, status: "failed", action: "re-iterate" };
    }
    db.prepare("UPDATE review_runs SET status = 'passed' WHERE id = ?").run(reviewRunId);
    if (run.gateRunId) {
      completeGateRun(run.gateRunId, "passed", verdict.summary);
    }
    return { ...verdict, action: "passed" };
  }

  if (verdict.status === "needs-human") {
    db.prepare("UPDATE review_runs SET status = 'escalated' WHERE id = ?").run(reviewRunId);
    if (run.gateRunId) {
      completeGateRun(run.gateRunId, "failed", "Escalated to human: " + verdict.summary);
    }
    return { ...verdict, action: "escalated" };
  }

  // Failed — check if we should re-iterate
  const config = loadConfig();
  const riskLevel = guessRiskFromPhaseTransition(run.cardId);
  const maxIter = getEffectiveMaxIterations(run.skillId, riskLevel, config);
  const followEdits = shouldFollowEdits(riskLevel, config);

  if (run.iteration < maxIter) {
    // If edits were made but we don't follow edits at this risk level, still pass
    if (verdict.madeEdits && !followEdits) {
      db.prepare("UPDATE review_runs SET status = 'passed' WHERE id = ?").run(reviewRunId);
      if (run.gateRunId) {
        completeGateRun(run.gateRunId, "passed", "Fixes applied; re-review not required at this risk level.");
      }
      return { ...verdict, status: "passed", action: "passed" };
    }

    // Mark as failed (will be re-iterated by heartbeat)
    db.prepare("UPDATE review_runs SET status = 'failed' WHERE id = ?").run(reviewRunId);
    if (run.gateRunId) {
      completeGateRun(run.gateRunId, "failed", verdict.summary);
    }
    return { ...verdict, action: "re-iterate" };
  }

  // Max iterations reached — escalate
  db.prepare("UPDATE review_runs SET status = 'escalated', verdict_summary = ? WHERE id = ?").run(
    `Max iterations (${maxIter}) reached: ${verdict.summary}`,
    reviewRunId
  );
  if (run.gateRunId) {
    completeGateRun(run.gateRunId, "failed", `Escalated after ${maxIter} iterations: ${verdict.summary}`);
  }
  return { ...verdict, action: "escalated" };
}

/**
 * Get all skills that should be triggered for a card at a phase transition.
 */
export function getRequiredReviewSkills(
  phaseTransition: string,
  riskLevel: RiskLevel
): SkillConfig[] {
  return getApplicableSkills(phaseTransition, riskLevel);
}

function buildReviewPrompt(skill: SkillConfig, iteration: number, maxIterations: number): string {
  let prompt = skill.prompt;

  if (iteration > 1) {
    prompt += `\n\nThis is iteration ${iteration}/${maxIterations} of the review. Previous review found issues. Please re-review the changes and verify the fixes are adequate. Focus on whether previously identified issues were resolved and whether new issues were introduced.`;
  }

  if (!skill.autoFix) {
    prompt += "\n\nReport findings only — do NOT make any code changes.";
  }

  // Verdict contract: the review machinery parses this token deterministically
  // (see verdict-parse.ts). Without it, a clean review can be misread as ambiguous
  // and escalate needlessly.
  prompt +=
    '\n\nWhen finished, end your reply with exactly one line stating your verdict, ' +
    'one of:\n"VERDICT: pass" (no blocking issues), ' +
    '"VERDICT: fail" (issues that must be addressed), or ' +
    '"VERDICT: needs-human" (cannot decide — human review required).';

  return prompt;
}

function guessRiskFromPhaseTransition(cardId: string): RiskLevel {
  const db = getDb();
  const row = db
    .prepare("SELECT risk_level FROM card_risk WHERE card_id = ?")
    .get(cardId) as { risk_level: string } | undefined;
  return (row?.risk_level as RiskLevel) ?? "medium";
}
