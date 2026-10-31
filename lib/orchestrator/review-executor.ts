import "server-only";

import { randomUUID } from "node:crypto";

import { getDb } from "@/lib/db/schema";
import {
  claimReviewJudgment,
  claimReviewStart,
  commitOwnedReviewOutcome,
  failOwnedReviewIfSourceChanged,
  linkOwnedReviewStartGate,
  renewReviewJudgmentLease,
  renewReviewStartLease,
} from "@/lib/db/review-run-store";
import {
  fetchChatTurnById,
  fetchTurnById,
  injectMessage,
  startPeerChatReview,
  disposePeerChat,
  verifyPlanReviewSource,
} from "@/lib/ahp/session-messenger";
import {
  loadConfig,
  getApplicableSkills,
  getEffectiveMaxIterations,
  shouldFollowEdits,
  type SkillConfig,
} from "./skill-config";
import {
  startGateRun,
  completeGateRun,
  getGateRunsForCard,
} from "./gate-engine";
import {
  normalizeChangesetRef,
  type Phase,
  type RiskLevel,
} from "@/lib/types";
import { extractReviewEvidence } from "./review-evidence";
import { decideReviewAction, type ReviewAction } from "./review-decision";
import { judgeReviewResponse } from "./verdict-judge";
import type { ReviewVerdict } from "./verdict-judge-core";
import { getRiskForAutomation } from "./risk-store";
import {
  awaitAbortable,
  isOperationAborted,
  throwIfAborted,
} from "@/lib/abort";
import { terminalizeCancelledReviewStart } from "./review-start-cancellation";
import {
  finalizeOwnedReviewDispatch,
  persistReviewStartFailure,
  prepareOwnedReviewDispatch,
  reconcileRecoveredReviewDispatch,
  shouldStartReviewForRun,
} from "./review-start-state";
import { attemptReviewPeerChatCleanup } from "./review-chat-cleanup";
import { PeerChatCleanupRequiredError } from "@/lib/ahp/peer-review-dispatch";
import { runLeaseRenewalTick } from "./lease-renewal";
import { WORK_LEASE_MS } from "@/lib/db/work-lease-schema";
import {
  assertOperationCurrent,
  getOperationSignal,
} from "./operation-context";
import { resolveAuthoritativeGateRevision } from "./gate-revision";
import { appendPlanReviewEvidence } from "./review-prompt";
import { isPlanSource, type PlanEvidence } from "../ahp/plan-source";

const REVIEW_JUDGMENT_LEASE_MS = 60_000;

interface RenewalScheduler {
  set(callback: () => void, delayMs: number): unknown;
  clear(handle: unknown): void;
}

const reviewRenewalScheduler: RenewalScheduler = {
  set(callback, delayMs) {
    const timer = setInterval(callback, delayMs);
    timer.unref();
    return timer;
  },
  clear(handle) {
    clearInterval(handle as ReturnType<typeof setInterval>);
  },
};

export type ReviewRunStatus =
  | "pending"
  | "dispatching"
  | "injected"
  | "extracting"
  | "passed"
  | "failed"
  | "cancelled"
  | "ambiguous"
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
  turnId: string | null;
  chatUri: string | null;
  chatCleanupStatus: "pending" | "completed" | "error" | null;
  chatCleanupError: string | null;
  chatCleanupAttempts: number;
  chatCleanupLastAttemptAt: string | null;
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
  turn_id: string | null;
  chat_uri: string | null;
  chat_cleanup_status: "pending" | "completed" | "error" | null;
  chat_cleanup_error: string | null;
  chat_cleanup_attempts: number;
  chat_cleanup_last_attempt_at: string | null;
  plan_source_json: string | null;
  source_digest: string | null;
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
    turnId: row.turn_id,
    chatUri: row.chat_uri,
    chatCleanupStatus: row.chat_cleanup_status,
    chatCleanupError: row.chat_cleanup_error,
    chatCleanupAttempts: row.chat_cleanup_attempts,
    chatCleanupLastAttemptAt: row.chat_cleanup_last_attempt_at,
  };
}

async function cleanupTerminalReviewChat(
  db: ReturnType<typeof getDb>,
  hostUrl: string,
  run: ReviewRun,
): Promise<void> {
  if (!run.chatUri) return;
  try {
    await attemptReviewPeerChatCleanup(
      db,
      hostUrl,
      run.id,
      run.chatUri,
      disposePeerChat,
    );
  } catch (error) {
    console.warn(
      `[review-executor] Could not persist peer-chat cleanup diagnostics for review run ${run.id}:`,
      error instanceof Error ? error.message : error,
    );
  }
}

/**
 * Get active review runs for a card (not in terminal state).
 */
export function getActiveReviewRuns(cardId: string): ReviewRun[] {
  const db = getDb();
  const rows = db
    .prepare(
      "SELECT * FROM review_runs WHERE card_id = ? AND status NOT IN ('passed', 'escalated', 'ambiguous', 'cancelled') ORDER BY id DESC"
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
 * Skips a skill whose latest run is already resolved or in-flight:
 *  - `passed`    → the gate is already satisfied for this changeset.
 *  - `escalated` → parked for a human; re-injecting would restart the churn.
 *  - `dispatching` → a durable pre-side-effect reservation is still unresolved.
 *  - `ambiguous` → dispatch may still be running and is never auto-retried.
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
  return shouldStartReviewForRun(latest, currentChangesetRef);
}

/**
 * Check if a card has all required review gates passing for a transition.
 */
export function hasPassingReviews(
  cardId: string,
  phaseTransition: string,
  riskLevel: RiskLevel,
  currentChangesetRef?: string,
): boolean {
  const skills = getApplicableSkills(phaseTransition, riskLevel);
  if (skills.length === 0) return true;
  const current = normalizeChangesetRef(currentChangesetRef);
  if (current === "") return false;

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
        "SELECT id, changeset_ref FROM review_runs WHERE card_id = ? AND skill_id = ? AND phase_transition = ? AND status = 'passed' ORDER BY id DESC LIMIT 1"
      )
      .get(cardId, skillId, phaseTransition) as {
        id: number;
        changeset_ref: string | null;
      } | undefined;

    if (
      !passingRun
      || normalizeChangesetRef(passingRun.changeset_ref ?? undefined) !== current
    ) {
      return false;
    }
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
  changesetRef?: string,
  options?: {
    pendingRequestId?: string;
    independent?: boolean;
    signal?: AbortSignal;
  },
): Promise<{
  reviewRunId: number;
  success: boolean;
  disposition: "terminal" | "retryable" | "needs-human";
  started?: boolean;
}> {
  if (normalizeChangesetRef(changesetRef) === "") {
    throw new Error(
      "Cannot start review without an authoritative current changeset revision.",
    );
  }
  const db = getDb();
  const planReview = phaseTransition === "plan->build";
  const planRevision = planReview
    ? resolveAuthoritativeGateRevision(db, cardId, "plan", hostUrl) : undefined;
  const plan = planRevision?.ok ? planRevision.plan : undefined;
  if (planReview && (!plan || plan.changesetRef !== changesetRef)) {
    throw new Error("Cannot review a plan without matching complete parent evidence.");
  }
  if (planReview) skill = { ...skill, autoFix: false };
  const maxIterations = getEffectiveMaxIterations(skill.id, riskLevel);
  const signal = options?.signal ?? getOperationSignal();
  const startOwnerId = randomUUID();

  throwIfAborted(signal);
  assertOperationCurrent("verify");
  const recoveredDispatch = reconcileRecoveredReviewDispatch(db, {
    cardId,
    skillId: skill.id,
    phaseTransition,
  });
  if (recoveredDispatch) {
    return {
      reviewRunId: recoveredDispatch.reviewRunId,
      success: false,
      disposition: "needs-human",
    };
  }
  const startClaim = claimReviewStart(db, {
    cardId,
    skillId: skill.id,
    phaseTransition,
    maxIterations,
    changesetRef,
    ownerId: startOwnerId,
    leaseMs: WORK_LEASE_MS,
  });
  if (startClaim.state === "ambiguous") {
    return {
      reviewRunId: startClaim.reviewRunId,
      success: false,
      disposition: "needs-human",
    };
  }
  if (startClaim.state === "active" || startClaim.state === "resolved") {
    return {
      reviewRunId: startClaim.reviewRunId,
      success: true,
      disposition: "terminal",
      started: false,
    };
  }
  if (startClaim.state === "maxed") {
    return {
      reviewRunId: startClaim.reviewRunId,
      success: false,
      disposition: "terminal",
    };
  }

  const reviewRunId = startClaim.reviewRunId;
  let gateRunId: number | undefined;
  let dispatchPreparation:
    | ReturnType<typeof prepareOwnedReviewDispatch>
    | undefined;
  const iteration = startClaim.iteration;
  const leaseState: { failure?: unknown } = {};
  const renewalTimer = reviewRenewalScheduler.set(() => {
    try {
      throwIfAborted(signal);
      assertOperationCurrent("verify");
    } catch {
      reviewRenewalScheduler.clear(renewalTimer);
      return;
    }
    runLeaseRenewalTick(
      leaseState,
      () => renewReviewStartLease(
        db,
        reviewRunId,
        startOwnerId,
        WORK_LEASE_MS,
      ),
      () => {},
      "Review dispatch lease ownership was lost.",
    );
  }, Math.max(1, Math.floor(WORK_LEASE_MS / 3)));
  try {
    const [fromPhase, toPhase] = phaseTransition.split("->") as [Phase, Phase];
    gateRunId = startGateRun({
      cardId,
      fromPhase,
      toPhase,
      gateType: "review",
      gateName: skill.id,
      changesetRef,
      signal,
      ownerId: startOwnerId,
    });
    throwIfAborted(signal);
    if (!linkOwnedReviewStartGate(
      db,
      reviewRunId,
      startOwnerId,
      gateRunId,
    )) {
      throw new Error("Review start claim was lost before gate linkage.");
    }

    const basePrompt = buildReviewPrompt(skill, iteration, maxIterations, cardId);
    const prompt = plan ? appendPlanReviewEvidence(basePrompt, plan) : basePrompt;
    const beforeDispatch = (identity: {
      chatUri: string;
      turnId: string;
      disposablePeerChat: boolean;
      planSourceJson?: string;
      sourceDigest?: string;
    }) => {
      assertOperationCurrent(
        skill.autoFix ? "review-edits" : planReview || options?.independent || options?.pendingRequestId ? "verify" : "interact",
      );
      dispatchPreparation = prepareOwnedReviewDispatch(
        db,
        {
          reviewRunId,
          ownerId: startOwnerId,
          hostUrl,
          ...identity,
        },
      );
      if (dispatchPreparation.state !== "ready") {
        throw new Error(
          dispatchPreparation.summary
            ?? "Review start claim was lost before prompt dispatch.",
        );
      }
    };
    const usePeerChat =
      planReview || options?.independent === true || Boolean(options?.pendingRequestId);
    const injection = usePeerChat
      ? await startPeerChatReview(
          hostUrl,
          sessionUri,
          options?.pendingRequestId,
          prompt,
          { signal, beforeDispatch, plan },
        )
      : await injectMessage(
          hostUrl,
          sessionUri,
          prompt,
          { signal, beforeDispatch },
        );
    const { success, turnId } = injection;
    const queued = "queued" in injection ? injection.queued : false;
    const chatUri = "chatUri" in injection ? injection.chatUri : undefined;
    if (success) {
      // Persist turnId only when the prompt started a turn immediately —
      // a queued message's id isn't guaranteed by the protocol to become the
      // eventual Turn.id (see fetchTurnById's docs), so recording it would
      // create a false sense of precision. Without an exact id, verdict
      // processing fails closed to human review.
      const persistedTurnId = queued ? null : turnId ?? null;
      const finalized = finalizeOwnedReviewDispatch(db, {
        hostUrl,
        reviewRunId,
        ownerId: startOwnerId,
        turnId: persistedTurnId,
        chatUri: chatUri ?? null,
        disposablePeerChat: usePeerChat,
      });
      if (finalized.state === "orphaned") {
        return {
          reviewRunId,
          success: false,
          disposition: "needs-human",
        };
      }
    } else {
      if (dispatchPreparation?.state === "blocked") {
        return {
          reviewRunId,
          success: false,
          disposition: "needs-human",
        };
      }
      if (leaseState.failure !== undefined) throw leaseState.failure;
      const reason = "reason" in injection && injection.reason
        ? injection.reason
        : "Failed to inject review prompt into session";
      const failure = persistReviewStartFailure(
        db,
        hostUrl,
        reviewRunId,
        reason,
        { ownerId: startOwnerId },
      );
      if (failure.applied) completeGateRun(gateRunId, "failed", reason);
    }

    return {
      reviewRunId,
      success,
      disposition: success ? "terminal" : "retryable",
      started: success,
    };
  } catch (err) {
    if (dispatchPreparation?.state === "blocked") {
      persistReviewStartFailure(db, hostUrl, reviewRunId, err, {
        ownerId: startOwnerId,
      });
      return {
        reviewRunId,
        success: false,
        disposition: "needs-human",
      };
    }
    const cleanupAfterCancellation = err instanceof PeerChatCleanupRequiredError
      && isOperationAborted(err.cause);
    if (isOperationAborted(err) || cleanupAfterCancellation) {
      if (cleanupAfterCancellation) {
        const failure = persistReviewStartFailure(
          db,
          hostUrl,
          reviewRunId,
          err,
          { ownerId: startOwnerId },
        );
        if (failure.applied && gateRunId !== undefined) {
          completeGateRun(
            gateRunId,
            "failed",
            "Review prompt dispatch is ambiguous; human review required",
          );
        }
      } else {
        terminalizeCancelledReviewStart(
          db,
          reviewRunId,
          gateRunId,
          completeGateRun,
          { ownerId: startOwnerId },
        );
      }
      return {
        reviewRunId,
        success: false,
        disposition: "retryable",
      };
    }
    const failure = persistReviewStartFailure(
      db,
      hostUrl,
      reviewRunId,
      err,
      { ownerId: startOwnerId },
    );
    if (failure.applied && gateRunId !== undefined) {
      completeGateRun(
        gateRunId,
        "failed",
        failure.disposition === "needs-human"
          ? "Review prompt dispatch is ambiguous; human review required"
          : "Exception before prompt dispatch"
      );
    }
    return {
      reviewRunId,
      success: false,
      disposition: failure.disposition,
    };
  } finally {
    reviewRenewalScheduler.clear(renewalTimer);
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
  currentChangesetRef?: string,
  projectPath?: string,
): Promise<(ReviewVerdict & { action: ReviewAction }) | null> {
  assertOperationCurrent();
  const ownedSignal = getOperationSignal();
  const signal = AbortSignal.any([
    ...(ownedSignal ? [ownedSignal] : []),
    AbortSignal.timeout(REVIEW_JUDGMENT_LEASE_MS),
  ]);
  const db = getDb();
  const ownerId = randomUUID();
  const row = claimReviewJudgment(
    db,
    reviewRunId,
    ownerId,
    REVIEW_JUDGMENT_LEASE_MS,
  );
  if (!row) {
    const exists = db.prepare(
      "SELECT 1 FROM review_runs WHERE id = ?",
    ).get(reviewRunId);
    if (exists) return null;
    return {
      status: "needs-human",
      summary: "Review run not found",
      findings: [],
      madeEdits: false,
      action: "escalated",
    };
  }

  const run = mapRow(row as ReviewRunRow);
  const planRun = run.phaseTransition === "plan->build";
  const freshness = failOwnedReviewIfSourceChanged(
    db,
    reviewRunId,
    ownerId,
    currentChangesetRef,
  );
  if (freshness === "lost") {
    return null;
  }
  if (freshness === "stale") {
    const staleVerdict: ReviewVerdict & { action: ReviewAction } = {
      status: "failed",
      summary:
        "Review evidence is stale because the source changed after dispatch; re-review required.",
      findings: [],
      madeEdits: false,
      action: "re-iterate",
    };
    await cleanupTerminalReviewChat(db, hostUrl, run);
    return staleVerdict;
  }

  const leaseState: { failure?: unknown } = {};
  const renewalTimer = reviewRenewalScheduler.set(() => {
    try {
      throwIfAborted(signal);
      assertOperationCurrent();
    } catch {
      reviewRenewalScheduler.clear(renewalTimer);
      return;
    }
    runLeaseRenewalTick(
      leaseState,
      () => renewReviewJudgmentLease(
        db,
        reviewRunId,
        ownerId,
        REVIEW_JUDGMENT_LEASE_MS,
      ),
      () => {},
      "Review judgment lease ownership was lost.",
    );
  }, Math.max(1, Math.floor(REVIEW_JUDGMENT_LEASE_MS / 3)));

  let result: (ReviewVerdict & { action: ReviewAction }) | null = null;
  let committed = false;
  let sourceGuard: import("../db/review-run-store").OwnedReviewOutcome["sourceGuard"];
  try {
    let verdict: ReviewVerdict;
    try {
      if (!run.turnId) {
        verdict = {
          status: "needs-human",
          summary: "Exact review turn is unavailable; human review required.",
          findings: [],
          madeEdits: false,
        };
      } else {
        const turn = await awaitAbortable(
          () => run.chatUri
            ? fetchChatTurnById(hostUrl, run.chatUri, run.turnId!)
            : fetchTurnById(hostUrl, sessionUri, run.turnId!),
          signal,
        );
        if (!turn) {
          verdict = {
            status: "needs-human",
            summary: "Exact review turn could not be found; human review required.",
            findings: [],
            madeEdits: false,
          };
        } else {
          const evidence = extractReviewEvidence(turn);
          const judgment = await awaitAbortable(
            () => judgeReviewResponse(evidence.response, planRun ? run.changesetRef ?? undefined : undefined),
            signal,
          );
          verdict = { ...judgment, madeEdits: evidence.madeEdits };
        }
      }
    } catch (error) {
      console.warn(
        `[review-executor] Failed to collect review evidence for run ${reviewRunId}:`,
        error instanceof Error ? error.message : error
      );
      verdict = {
        status: "needs-human",
        summary: "Review evidence could not be processed; human review required.",
        findings: [],
        madeEdits: false,
      };
    }
    if (leaseState.failure !== undefined) return null;
    throwIfAborted(signal);
    assertOperationCurrent();

    const config = loadConfig(projectPath);
    const riskLevel = getRiskForAutomation(run.cardId, hostUrl);
    const maxIterations = run.maxIterations;
    if (planRun) {
      const revision = resolveAuthoritativeGateRevision(db, run.cardId, "plan", hostUrl);
      try {
        const source: unknown = row.plan_source_json ? JSON.parse(row.plan_source_json) : undefined;
        if (!revision.ok || !revision.plan || revision.changesetRef !== run.changesetRef
          || !isPlanSource(source, run.cardId) || !row.source_digest
          || JSON.stringify(source) !== JSON.stringify(revision.plan.source)) {
          throw new Error("Complete, current plan review provenance is unavailable.");
        }
        const evidence: PlanEvidence = { ...revision.plan, source };
        await verifyPlanReviewSource(hostUrl, run.cardId, evidence, row.source_digest, signal);
        throwIfAborted(signal);
        assertOperationCurrent();
        sourceGuard = {
          hostUrl, changesetRef: revision.changesetRef, sourceRevision: revision.sourceRevision,
        };
        if (verdict.madeEdits) throw new Error("The plan reviewer used editing tools; report-only review cannot pass.");
      } catch (error) {
        console.warn("[review-executor] Plan review evidence rejected:", error instanceof Error ? error.message : error);
        verdict = {
          status: "needs-human", findings: [], madeEdits: verdict.madeEdits,
          summary: error instanceof Error ? error.message : "Plan review evidence could not be verified.",
        };
      }
    }
    if (leaseState.failure !== undefined) return null;
    throwIfAborted(signal);
    assertOperationCurrent();
    const action = decideReviewAction(
      verdict,
      run.iteration,
      maxIterations,
      shouldFollowEdits(riskLevel, config)
    );

    if (action === "passed") {
      committed = commitOwnedReviewOutcome(db, reviewRunId, ownerId, {
        reviewStatus: "passed",
        verdictSummary: verdict.summary,
        findings: verdict.findings,
        gateStatus: "passed",
        gateOutput: verdict.summary,
        sourceGuard,
      });
      result = committed ? { ...verdict, action } : null;
    } else if (action === "re-iterate") {
      const gateOutput = verdict.status === "passed"
        ? "Fixes applied — re-review required at this risk level."
        : verdict.summary;
      committed = commitOwnedReviewOutcome(db, reviewRunId, ownerId, {
        reviewStatus: "failed",
        verdictSummary: verdict.summary,
        findings: verdict.findings,
        gateStatus: "failed",
        gateOutput,
      });
      result = committed
        ? {
            ...verdict,
            status: verdict.status === "passed" ? "failed" : verdict.status,
            action,
          }
        : null;
    } else if (verdict.status === "needs-human") {
      committed = commitOwnedReviewOutcome(db, reviewRunId, ownerId, {
        reviewStatus: "escalated",
        verdictSummary: verdict.summary,
        findings: verdict.findings,
        gateStatus: "failed",
        gateOutput: "Escalated to human: " + verdict.summary,
      });
      result = committed ? { ...verdict, action } : null;
    } else {
      const summary =
        `Max iterations (${maxIterations}) reached: ${verdict.summary}`;
      committed = commitOwnedReviewOutcome(db, reviewRunId, ownerId, {
        reviewStatus: "escalated",
        verdictSummary: summary,
        findings: verdict.findings,
        gateStatus: "failed",
        gateOutput:
          `Escalated after ${maxIterations} iterations: ${verdict.summary}`,
      });
      result = committed ? { ...verdict, action } : null;
    }
  } finally {
    reviewRenewalScheduler.clear(renewalTimer);
  }
  if (committed) await cleanupTerminalReviewChat(db, hostUrl, run);
  return result;
}

/** Whether the exact peer-chat review turn has completed and can be judged. */
export async function isReviewResultReady(
  hostUrl: string,
  run: ReviewRun,
): Promise<boolean> {
  if (!run.chatUri || !run.turnId) return false;
  return Boolean(await fetchChatTurnById(hostUrl, run.chatUri, run.turnId));
}

/**
 * Get all skills that should be triggered for a card at a phase transition.
 */
export function getRequiredReviewSkills(
  phaseTransition: string,
  riskLevel: RiskLevel,
  projectPath?: string
): SkillConfig[] {
  return getApplicableSkills(phaseTransition, riskLevel, loadConfig(projectPath));
}

function buildReviewPrompt(
  skill: SkillConfig,
  iteration: number,
  maxIterations: number,
  cardId: string
): string {
  let prompt = skill.prompt;

  if (skill.id === "review-report") {
    const latestByGate = new Map<string, ReturnType<typeof getGateRunsForCard>[number]>();
    for (const run of getGateRunsForCard(cardId)) {
      if (run.fromPhase !== "build" || run.toPhase !== "review") continue;
      const key = `${run.gateType}:${run.gateName ?? ""}`;
      if (!latestByGate.has(key)) latestByGate.set(key, run);
    }
    const evidence = [...latestByGate.values()]
      .map((run) => {
        const output = run.output?.trim();
        return [
          `- ${run.gateName ?? run.gateType}: ${run.status}`,
          run.completedAt ? `completed ${run.completedAt}` : undefined,
          output ? `evidence: ${output.slice(0, 1_000)}` : undefined,
        ].filter(Boolean).join("; ");
      })
      .join("\n");
    prompt +=
      "\n\nPlanwerk build-to-review gate evidence:\n" +
      (evidence || "- No completed build gate evidence was available; call this out in review.md.");
  }

  if (iteration > 1) {
    prompt += `\n\nThis is iteration ${iteration}/${maxIterations} of the review. Previous review found issues. Please re-review the changes and verify the fixes are adequate. Focus on whether previously identified issues were resolved and whether new issues were introduced.`;
  }

  if (!skill.autoFix) {
    prompt += "\n\nReport findings only — do NOT make any code changes.";
  }

  return prompt;
}
