import "server-only";

import { getDb } from "@/lib/db/schema";
import { KanbanCard, Phase, RiskLevel, PendingInput, normalizeChangesetRef } from "@/lib/types";
import { loadConfig } from "./skill-config";
import { getActiveReviewRuns, startReview, processReviewResult, getRequiredReviewSkills, hasPlanRubberDuck, recordPlanRubberDuck, shouldStartReview } from "./review-executor";
import { canAdvancePhase, setCardPhase, getNextPhase, computeChangesetRef, startGateRun, getGateRunsForCard, completeGateRun, executeGateCommand } from "./gate-engine";
import { getCardRisk } from "./risk-store";
import { shouldAutoAnswer, autoAnswer } from "./auto-answerer";
import { injectMessage, answerInput, requestPlanChanges } from "@/lib/ahp/session-messenger";
import { syncCoherence } from "./coherence-engine";
import { runCoherenceExecutor, type ReviewCardCtx } from "./coherence-reviewer";
import { advanceReviewToShip } from "./phase-advance";

/**
 * Heartbeat action types emitted to the orchestrator feed.
 */
export type HeartbeatAction =
  | { type: "gate-triggered"; cardId: string; gateType: string }
  | { type: "review-injected"; cardId: string; skillId: string; iteration: number }
  | { type: "phase-advanced"; cardId: string; from: Phase; to: Phase }
  | { type: "nudge-sent"; cardId: string; message: string }
  | { type: "review-passed"; cardId: string; skillId: string }
  | { type: "escalated"; cardId: string; reason: string }
  | { type: "stale-gate-invalidated"; cardId: string; gateType: string }
  | { type: "wip-violation"; phase: Phase; count: number; limit: number }
  | { type: "auto-answered"; cardId: string; answer: string }
  | { type: "plan-approved"; cardId: string }
  | { type: "plan-approve-failed"; cardId: string; reason: string }
  | { type: "plan-rubber-ducked"; cardId: string }
  | { type: "plan-rubber-duck-failed"; cardId: string; reason: string }
  | { type: "coherence-conflict"; cardId: string; otherCardId: string; summary: string }
  | { type: "coherence-cleared"; cardId: string; otherCardId: string }
  | { type: "coherence-blocked"; cardId: string; reason: string };

export interface HeartbeatTickResult {
  actions: HeartbeatAction[];
  errors: string[];
}

interface HeartbeatState {
  lastTickAt: number;
  tickCount: number;
  stuckSince: Map<string, number>;
  nudgeCount: Map<string, number>;
  gateRetryCount: Map<string, number>;
  pipelineStage: Map<string, "gates" | "review" | "advancing">;
  lastWipViolations: Map<string, number>; // phase → count when last emitted
  coherenceBlocked: Set<string>; // cards for which a ship-block was already announced
  planBusySince: Map<string, number>; // plan-phase card → first tick seen continuously running
}

const state: HeartbeatState = {
  lastTickAt: 0,
  tickCount: 0,
  stuckSince: new Map(),
  nudgeCount: new Map(),
  gateRetryCount: new Map(),
  pipelineStage: new Map(),
  lastWipViolations: new Map(),
  coherenceBlocked: new Set(),
  planBusySince: new Map(),
};

let heartbeatInterval: ReturnType<typeof setInterval> | null = null;
let onAction: ((action: HeartbeatAction) => void) | null = null;
let tickInProgress = false;

/**
 * Start the heartbeat loop. Only one loop runs at a time.
 * Returns a stop function.
 */
export function startHeartbeat(
  hostUrl: string,
  getCards: () => KanbanCard[],
  actionHandler: (action: HeartbeatAction) => void
): () => void {
  if (heartbeatInterval) return () => stopHeartbeat();

  onAction = actionHandler;
  const config = loadConfig();
  const intervalMs = config.orchestrator.heartbeatInterval;

  heartbeatInterval = setInterval(() => {
    if (tickInProgress) return; // Skip if previous tick still running
    tickInProgress = true;
    runTick(hostUrl, getCards())
      .catch((err) => {
        console.warn("[heartbeat] tick error:", err instanceof Error ? err.message : err);
      })
      .finally(() => {
        tickInProgress = false;
      });
  }, intervalMs);

  // Run immediately on start
  tickInProgress = true;
  runTick(hostUrl, getCards())
    .catch((err) => {
      console.warn("[heartbeat] initial tick error:", err instanceof Error ? err.message : err);
    })
    .finally(() => {
      tickInProgress = false;
    });

  return () => stopHeartbeat();
}

export function stopHeartbeat(): void {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
  onAction = null;
}

export function isHeartbeatRunning(): boolean {
  return heartbeatInterval !== null;
}

function emit(action: HeartbeatAction): void {
  if (onAction) onAction(action);
  logAction(action);
}

function logAction(action: HeartbeatAction): void {
  const db = getDb();
  db.prepare(
    "INSERT INTO heartbeat_log (detection, card_id, action_taken, detail) VALUES (?, ?, ?, ?)"
  ).run(
    action.type,
    "cardId" in action ? action.cardId : null,
    action.type,
    JSON.stringify(action)
  );
}

/**
 * Check if a phase has room under its WIP limit.
 */
function canEnterPhase(phase: Phase, cards: KanbanCard[], config: ReturnType<typeof loadConfig>): boolean {
  const limit = config.wipLimits[phase];
  if (!limit) return true;
  const count = cards.filter((c) => c.phase === phase && !c.isArchived).length;
  return count < limit;
}

/**
 * Core tick logic: scan cards and execute the build-phase pipeline.
 */
async function runTick(hostUrl: string, cards: KanbanCard[]): Promise<HeartbeatTickResult> {
  state.lastTickAt = Date.now();
  state.tickCount++;
  const config = loadConfig();
  const actions: HeartbeatAction[] = [];
  const errors: string[] = [];

  // Process non-archived, non-shipped cards. `define` cards are normally
  // skipped, but a brand-new session's plan-approval (and other input requests)
  // can appear while planwerk still has the card in `define`, so include
  // define cards that are waiting on input.
  const activeCards = cards.filter(
    (c) =>
      !c.isArchived &&
      c.phase !== "ship" &&
      (c.phase !== "define" || c.runtime === "input-needed")
  );

  for (const card of activeCards) {
    try {
      const cardActions = await processCard(hostUrl, card, config, cards);
      actions.push(...cardActions);
    } catch (err) {
      const msg = `${card.id}: ${err instanceof Error ? err.message : String(err)}`;
      if (process.env.AHP_DEBUG) console.warn("[heartbeat:card-error]", msg);
      errors.push(msg);
    }
  }

  // Track stuck cards
  for (const card of activeCards) {
    if (card.runtime === "idle" && !state.stuckSince.has(card.id)) {
      state.stuckSince.set(card.id, Date.now());
    } else if (card.runtime === "running") {
      state.stuckSince.delete(card.id);
      state.nudgeCount.delete(card.id);
    }
  }

  // Track how long a plan-phase card has been continuously *running*. Feeds the
  // opt-in busy plan-review injection (see maybeInjectBusyPlanReview): the
  // timestamp is set the first tick a plan card is seen running and cleared the
  // moment it idles or leaves the plan phase, so the elapsed check only fires
  // for genuinely heads-down plan work. Iterates the full card list (not just
  // activeCards) so archived/shipped cards don't retain a stale timestamp.
  for (const card of cards) {
    if (card.phase === "plan" && card.runtime === "running") {
      if (!state.planBusySince.has(card.id)) {
        state.planBusySince.set(card.id, Date.now());
      }
    } else {
      state.planBusySince.delete(card.id);
    }
  }

  // WIP violation detection (board-level, only emit on state change)
  const wipLimits = config.wipLimits;
  const phaseCount: Record<string, number> = {};
  for (const card of activeCards) {
    phaseCount[card.phase] = (phaseCount[card.phase] ?? 0) + 1;
  }
  for (const [phase, limit] of Object.entries(wipLimits)) {
    const count = phaseCount[phase] ?? 0;
    const lastCount = state.lastWipViolations.get(phase);
    if (count > limit && lastCount !== count) {
      state.lastWipViolations.set(phase, count);
      const action: HeartbeatAction = { type: "wip-violation", phase: phase as Phase, count, limit };
      emit(action);
      actions.push(action);
    } else if (count <= limit) {
      state.lastWipViolations.delete(phase);
    }
  }

  // Board-level coherence pass (horizontal gate). Deterministic detection + cleanup
  // run here; the LLM review is kicked fire-and-forget so it never blocks the tick.
  if (config.coherence.enabled) {
    try {
      const escalatable = syncCoherence(cards, config.coherence);
      if (escalatable.length > 0) {
        const ctxById = buildCoherenceCtx(cards);
        // Fire-and-forget: reviewer runs off-tick; verdicts are emitted when ready.
        void runCoherenceExecutor(hostUrl, escalatable, ctxById)
          .then((outcomes) => {
            for (const o of outcomes) emitCoherenceOutcome(o);
          })
          .catch((err) => {
            if (process.env.AHP_DEBUG) console.warn("[heartbeat:coherence]", err);
          });
      }
    } catch (err) {
      errors.push(`coherence: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { actions, errors };
}

/** Build per-card review context (title, plan, last message) for the executor. */
function buildCoherenceCtx(cards: KanbanCard[]): Map<string, ReviewCardCtx> {
  const map = new Map<string, ReviewCardCtx>();
  for (const c of cards) {
    const planContent = c.artifacts?.find((a) => a.type === "plan" && a.contentRef)?.contentRef;
    map.set(c.id, {
      id: c.id,
      title: c.title,
      planContent,
      lastAgentMessage: c.lastAgentMessage,
    });
  }
  return map;
}

/** Translate an executor verdict into a feed action. */
function emitCoherenceOutcome(o: {
  cardA: string;
  cardB: string;
  status: "conflict" | "coherent" | "needs-human";
  summary: string;
}): void {
  if (o.status === "conflict") {
    emit({ type: "coherence-conflict", cardId: o.cardA, otherCardId: o.cardB, summary: o.summary });
  } else if (o.status === "coherent") {
    emit({ type: "coherence-cleared", cardId: o.cardA, otherCardId: o.cardB });
  } else {
    emit({ type: "coherence-blocked", cardId: o.cardA, reason: o.summary });
  }
}

async function processCard(
  hostUrl: string,
  card: KanbanCard,
  config: ReturnType<typeof loadConfig>,
  allCards: KanbanCard[]
): Promise<HeartbeatAction[]> {
  const actions: HeartbeatAction[] = [];
  const storedRisk = getCardRisk(card.id);
  const riskLevel: RiskLevel = storedRisk?.level ?? card.risk ?? "medium";

  // Only process idle cards — running cards are doing work
  if (card.runtime !== "idle") {
    if (card.runtime === "input-needed") {
      const planApproval = detectPlanApproval(card.pendingInput);
      if (planApproval) {
        // Plan-approval inputs are handled by the plan-approval pipeline:
        // auto-approve low risk, force a rubber-duck on un-reviewed medium+ plans.
        const planActions = await runPlanApprovalPipeline(
          hostUrl,
          card,
          card.pendingInput!,
          planApproval
        );
        actions.push(...planActions);
      } else if (shouldAutoAnswer(card)) {
        // Regular clarifying question — auto-answer below the risk threshold.
        const result = await autoAnswer(hostUrl, card);
        if (result.answered) {
          const action: HeartbeatAction = { type: "auto-answered", cardId: card.id, answer: result.answer ?? "" };
          emit(action);
          actions.push(action);
        }
      }
    } else if (card.runtime === "running" && card.phase === "plan") {
      // Opt-in: a plan card that's been heads-down coding never idles, so the
      // idle-only plan-review gate would never run. When enabled, inject it via
      // a queued message so the gate still grades before any advance. Key on the
      // plan content, not the code diff (this is a plan review).
      const planRef = card.planContentHash;
      const busyActions = await maybeInjectBusyPlanReview(hostUrl, card, riskLevel, planRef, config);
      actions.push(...busyActions);
    }
    return actions;
  }

  const phase = card.phase;
  // Code-diff freshness ref for build/review→ship gates. Only trust it when the
  // card's diff counts are session-scoped (verified); otherwise pass `undefined`
  // ("unknown") so a flapping shared working-tree summary can't invalidate a
  // passed gate. Plan→build gates use the plan-content ref instead (see below).
  const codeChangesetRef = card.changesetVerified
    ? computeChangesetRef(card.filesChanged, card.additions, card.deletions, card.modifiedAt)
    : undefined;
  // Plan→build reviews review the plan artifact, so key their freshness on the
  // plan content, never the code diff. `undefined` when no plan is loaded yet.
  const planChangesetRef = card.planContentHash;

  // Build phase pipeline: deterministic gates → review skills → auto-advance
  if (phase === "build") {
    const buildActions = await runBuildPipeline(hostUrl, card, riskLevel, codeChangesetRef, config, allCards);
    actions.push(...buildActions);
  }

  // Plan phase: check for plan review gates
  if (phase === "plan") {
    const planActions = await runPlanPipeline(hostUrl, card, riskLevel, planChangesetRef, allCards);
    actions.push(...planActions);
  }

  // Review phase: check for review skills
  if (phase === "review") {
    const reviewActions = await runReviewPipeline(hostUrl, card, riskLevel, codeChangesetRef, allCards);
    actions.push(...reviewActions);
  }

  // Check for stuck sessions (beyond stale threshold)
  const staleThresholdMs = config.orchestrator.staleThreshold;
  const stuckSince = state.stuckSince.get(card.id);
  if (stuckSince && Date.now() - stuckSince > staleThresholdMs) {
    const nudges = state.nudgeCount.get(card.id) ?? 0;
    if (nudges < 3) {
      const msg = buildNudgeMessage(card, nudges);
      // Note: in production this would use the session URI from the card
      // For now, emit the action for the feed
      emit({ type: "nudge-sent", cardId: card.id, message: msg });
      actions.push({ type: "nudge-sent", cardId: card.id, message: msg });
      state.nudgeCount.set(card.id, nudges + 1);
    }
  }

  return actions;
}

/**
 * Inject any not-yet-started review skills for a transition. A skill is skipped
 * when its latest run is a *fresh* terminal outcome — `passed` (gate already
 * satisfied for this changeset) or `escalated` (parked for a human; re-injecting
 * would restart the churn). A terminal run against a stale changeset re-opens, so
 * genuinely new changes still get reviewed. When every skill is satisfied or
 * parked, nothing is injected and the card waits (surfaced as `needs-human`).
 */
async function startPendingReviews(
  hostUrl: string,
  card: KanbanCard,
  transition: string,
  riskLevel: RiskLevel,
  changesetRef?: string
): Promise<HeartbeatAction[]> {
  const actions: HeartbeatAction[] = [];
  const skills = getRequiredReviewSkills(transition, riskLevel).filter(
    (skill) => shouldStartReview(card.id, skill.id, transition, changesetRef)
  );
  for (const skill of skills) {
    const { success } = await startReview(
      hostUrl,
      card.id,
      card.id,
      skill,
      transition,
      riskLevel,
      changesetRef
    );
    if (success) {
      const action: HeartbeatAction = { type: "review-injected", cardId: card.id, skillId: skill.id, iteration: 1 };
      emit(action);
      actions.push(action);
    }
  }
  return actions;
}

/**
 * Build phase pipeline: deterministic gates → review skills → auto-advance.
 */
async function runBuildPipeline(
  hostUrl: string,
  card: KanbanCard,
  riskLevel: RiskLevel,
  changesetRef: string | undefined,
  config: ReturnType<typeof loadConfig>,
  allCards: KanbanCard[]
): Promise<HeartbeatAction[]> {
  const actions: HeartbeatAction[] = [];
  const transition = "build->review";

  if (!config.orchestrator.autoTriggerGates) return actions;

  // Step 1: Check deterministic gates (lint, typecheck, test)
  const { allowed: gatesPassed, pendingGates } = canAdvancePhase(
    card.id,
    "build",
    "review",
    card.workingDirectory,
    riskLevel,
    changesetRef
  );

  // Deterministic gates that haven't been triggered yet
  const deterministicPending = pendingGates.filter(
    (g) => g.gateType !== "review" && g.gateType !== "human-approval"
  );

  if (deterministicPending.length > 0) {
    state.pipelineStage.set(card.id, "gates");

    const existingRuns = getGateRunsForCard(card.id);
    const currentCodeRef = normalizeChangesetRef(changesetRef);
    for (const gate of deterministicPending) {
      // Compare on the normalized (code-only) changeset ref: the raw ref carries
      // a modifiedAt suffix that ticks on any activity, which would otherwise
      // make every gate look "new" and re-run constantly.

      // Skip if a run is already in flight for this code changeset.
      const alreadyRunning = existingRuns.find(
        (r) => r.gateType === gate.gateType && r.status === "running" &&
          normalizeChangesetRef(r.changesetRef) === currentCodeRef
      );
      if (alreadyRunning) continue;

      // Skip if this gate already failed for the same code changeset. Re-running
      // a deterministic gate against unchanged code just reproduces the failure,
      // so we wait for the code (and thus the ref) to change. Without this the
      // heartbeat re-triggers broken gates every cycle (thousands of dead runs).
      const alreadyFailed = existingRuns.find(
        (r) => r.gateType === gate.gateType && r.status === "failed" &&
          normalizeChangesetRef(r.changesetRef) === currentCodeRef
      );
      if (alreadyFailed) continue;

      // Detect stale passed gates that need re-triggering
      const staleRun = existingRuns.find(
        (r) => r.gateType === gate.gateType && r.status === "passed" &&
          changesetRef && normalizeChangesetRef(r.changesetRef) !== currentCodeRef
      );

      // Start (or re-start) the gate
      const runId = startGateRun(card.id, "build", "review", gate.gateType, gate.gateName, changesetRef);

      if (staleRun) {
        const action: HeartbeatAction = { type: "stale-gate-invalidated", cardId: card.id, gateType: gate.gateType };
        emit(action);
        actions.push(action);
      } else {
        const action: HeartbeatAction = { type: "gate-triggered", cardId: card.id, gateType: gate.gateType };
        emit(action);
        actions.push(action);
      }

      // Execute the gate command if available, otherwise nudge agent
      if (gate.command && card.workingDirectory) {
        executeGateCommand(runId, gate.command, card.workingDirectory);
      } else if (gate.command) {
        // No working directory — nudge agent to run the check
        const nudge = `Please run: ${gate.command}`;
        injectMessage(hostUrl, card.id, nudge).catch(() => {});
      } else {
        // No command (manual gate) — pass immediately
        completeGateRun(runId, "passed", "No command configured");
      }
    }
    return actions;
  }

  // Step 2: All deterministic gates pass → trigger review skills
  const reviewPending = pendingGates.filter((g) => g.gateType === "review");
  if (reviewPending.length > 0 && config.orchestrator.autoInjectReviews) {
    state.pipelineStage.set(card.id, "review");

    // Check for active review runs
    const activeReviews = getActiveReviewRuns(card.id);
    if (activeReviews.length === 0) {
      // No active reviews — start any that aren't parked on a human escalation.
      actions.push(...(await startPendingReviews(hostUrl, card, transition, riskLevel, changesetRef)));
    } else {
      // Active reviews exist — handle based on status
      for (const review of activeReviews) {
        if (review.status === "injected") {
          // Session should be idle now — extract verdict
          const sessionUri = card.id;
          const verdict = await processReviewResult(hostUrl, sessionUri, review.id, changesetRef);
          if (verdict.action === "passed") {
            emit({ type: "review-passed", cardId: card.id, skillId: review.skillId });
            actions.push({ type: "review-passed", cardId: card.id, skillId: review.skillId });
          } else if (verdict.action === "escalated") {
            emit({ type: "escalated", cardId: card.id, reason: verdict.summary });
            actions.push({ type: "escalated", cardId: card.id, reason: verdict.summary });
          }
          // re-iterate: status will be 'failed', picked up below on next tick
        } else if (review.status === "failed") {
          // Failed review needs re-injection (re-iteration)
          const skills = getRequiredReviewSkills(transition, riskLevel);
          const skill = skills.find((s) => s.id === review.skillId);
          if (skill) {
            const sessionUri = card.id;
            const { success } = await startReview(
              hostUrl,
              sessionUri,
              card.id,
              skill,
              transition,
              riskLevel,
              changesetRef
            );
            if (success) {
              const action: HeartbeatAction = {
                type: "review-injected",
                cardId: card.id,
                skillId: skill.id,
                iteration: review.iteration + 1,
              };
              emit(action);
              actions.push(action);
            }
          }
        }
      }
    }
    return actions;
  }

  // Step 3: All gates pass (including reviews) → auto-advance
  if (gatesPassed && config.orchestrator.autoAdvancePhases) {
    const nextPhase = getNextPhase("build");
    if (nextPhase && canEnterPhase(nextPhase, allCards, config)) {
      state.pipelineStage.set(card.id, "advancing");
      setCardPhase(card.id, nextPhase);
      const action: HeartbeatAction = { type: "phase-advanced", cardId: card.id, from: "build", to: nextPhase };
      emit(action);
      actions.push(action);
      state.pipelineStage.delete(card.id);
      state.stuckSince.delete(card.id);
    }
  }

  return actions;
}

/**
 * copilotcli plan-approval (exit-plan-mode) option IDs. A pending input whose
 * single-select options are drawn from this set is a plan approval, not a
 * regular clarifying question.
 */
const PLAN_APPROVAL_ACTION_IDS = new Set([
  "autopilot",
  "autopilot_fleet",
  "interactive",
  "exit_only",
]);

/**
 * Detect a plan-approval input ("How would you like to proceed?" with
 * autopilot / interactive / approve-plan-only options). Returns the question
 * ID and the option to pick when auto-approving (an execute action, never the
 * "approve only, I'll implement it myself" option), or null if not a plan
 * approval.
 */
function detectPlanApproval(
  input: PendingInput | undefined
): { questionId: string; approveOptionId: string } | null {
  if (!input || input.questions.length !== 1) return null;
  const q = input.questions[0];
  if (q.kind !== "single-select" || !q.options?.length) return null;
  // Every option must be a known plan-approval action (this avoids matching
  // generic single-select questions), and at least one must be an executable
  // (non-"exit_only") action so auto-approve can actually proceed.
  const allApproval = q.options.every((o) => PLAN_APPROVAL_ACTION_IDS.has(o.id));
  const hasExecute = q.options.some((o) => o.id !== "exit_only");
  if (!allApproval || !hasExecute) return null;

  // Prefer an execute action (autopilot → autopilot_fleet → interactive) so
  // auto-approve actually proceeds; fall back to any non-"exit_only" option.
  const approve =
    q.options.find((o) => o.id === "autopilot") ??
    q.options.find((o) => o.id === "autopilot_fleet") ??
    q.options.find((o) => o.id === "interactive") ??
    q.options.find((o) => o.id !== "exit_only") ??
    q.options[0];

  return { questionId: q.id, approveOptionId: approve.id };
}

/** Rubber-duck critique injected to force a plan revision on medium+ plans. */
const PLAN_RUBBER_DUCK_FEEDBACK =
  "Before approval, rubber-duck this plan: challenge each assumption, enumerate " +
  "the edge cases, failure modes, and gaps you have not addressed, verify the " +
  "files/imports/types you intend to touch actually exist and fit, and tighten " +
  "the scope. Then produce a revised plan and present it for approval.";

/**
 * Plan-approval pipeline for input-needed cards sitting on a copilotcli
 * plan-approval:
 * - Low risk → auto-approve (accept the recommended execute action).
 * - Medium+ risk that has not been rubber-ducked → force one plan revision,
 *   then leave the revised plan for a human to approve.
 * - Medium+ risk already rubber-ducked → leave for human (no-op).
 */
async function runPlanApprovalPipeline(
  hostUrl: string,
  card: KanbanCard,
  input: PendingInput,
  approval: { questionId: string; approveOptionId: string }
): Promise<HeartbeatAction[]> {
  const actions: HeartbeatAction[] = [];

  // Only auto-approve when the card was *explicitly* assessed as low risk.
  // Un-triaged plans (no stored risk) are treated as medium+ and rubber-ducked,
  // so a plan never advances to build without either an explicit low verdict or
  // a review pass. The card's own `risk` field defaults to "low" before triage,
  // so it is not trusted here — only the persisted assessment is.
  const assessedLow = getCardRisk(card.id)?.level === "low";

  if (assessedLow) {
    const answers = {
      [approval.questionId]: {
        state: "submitted",
        value: { kind: "selected", value: approval.approveOptionId },
      },
    };
    // `answerInput` now returns success only when the host actually consumed the
    // plan-approval (the request left `inputNeeded`) — a bare dispatch+ping can
    // report a phantom success without confirming the plan. Retry once on a
    // dispatched-but-not-applied result, then surface a failure so the card
    // doesn't silently sit in plan while the log claims it was approved.
    let result = await answerInput(hostUrl, card.id, input.requestId, "accept", answers);
    if (!result.success && !result.stale) {
      result = await answerInput(hostUrl, card.id, input.requestId, "accept", answers);
    }

    if (result.success) {
      const action: HeartbeatAction = { type: "plan-approved", cardId: card.id };
      emit(action);
      actions.push(action);
    } else if (!result.stale) {
      // Dispatched but the host never consumed it — a genuine failure. (A
      // `stale` result means the input was already gone, e.g. a human approved
      // it in the UI first; that's a no-op, not a failure, so stay silent and
      // let the next tick re-evaluate the card's real state.)
      const action: HeartbeatAction = {
        type: "plan-approve-failed",
        cardId: card.id,
        reason: "Dispatched the plan approval but the host never confirmed it (still awaiting input).",
      };
      emit(action);
      actions.push(action);
    }
    return actions;
  }

  // Medium+ risk: force a single rubber-duck pass on plans not yet reviewed.
  if (hasPlanRubberDuck(card.id)) {
    // Already rubber-ducked — leave the revised plan for a human to approve.
    return actions;
  }

  const { success, stale } = await requestPlanChanges(
    hostUrl,
    card.id,
    input.requestId,
    PLAN_RUBBER_DUCK_FEEDBACK
  );
  if (success) {
    recordPlanRubberDuck(card.id);
    const action: HeartbeatAction = { type: "plan-rubber-ducked", cardId: card.id };
    emit(action);
    actions.push(action);
  } else {
    // The decline landed but the follow-up critique never reached the agent
    // (e.g. it surfaced a shape we couldn't answer, or timed out). Surface it —
    // otherwise the card sits blocked on an unanswerable question with no trace.
    const reason = stale
      ? "Plan-approval input went stale before feedback could be delivered."
      : "Declined the plan but could not deliver the review feedback to the agent.";
    const action: HeartbeatAction = { type: "plan-rubber-duck-failed", cardId: card.id, reason };
    emit(action);
    actions.push(action);
  }
  return actions;
}

/**
 * Opt-in busy plan-review injection. A plan-phase card that keeps *running* never
 * hits the idle-only plan pipeline, so its plan-review gate would never fire and
 * it sits in Plan while visibly building. When `injectReviewsWhileBusy` is on and
 * the card has been continuously running past `planBusyThreshold`, inject the
 * pending plan-review via a queued message (processed when the agent's turn ends).
 * De-duped through active-run + `shouldStartReview` checks; the gate still grades
 * before any advance, so the "only the gate engine advances phase" invariant holds.
 */
async function maybeInjectBusyPlanReview(
  hostUrl: string,
  card: KanbanCard,
  riskLevel: RiskLevel,
  changesetRef: string | undefined,
  config: ReturnType<typeof loadConfig>
): Promise<HeartbeatAction[]> {
  if (!config.orchestrator.injectReviewsWhileBusy) return [];
  if (!config.orchestrator.autoInjectReviews) return [];

  // Only act once the card has been continuously running long enough that this
  // is clearly sustained plan work, not a brief burst.
  const busySince = state.planBusySince.get(card.id);
  if (!busySince || Date.now() - busySince < config.orchestrator.planBusyThreshold) {
    return [];
  }

  const { allowed, pendingGates } = canAdvancePhase(
    card.id,
    "plan",
    "build",
    card.workingDirectory,
    riskLevel,
    changesetRef
  );
  // Already advanceable, or nothing review-shaped is pending → leave it to the
  // normal idle path; don't interrupt the agent.
  if (allowed) return [];
  if (!pendingGates.some((g) => g.gateType === "review")) return [];

  // A review is already in flight (pending/injected/extracting) for this card —
  // don't double-inject. A `failed` run is intentionally *not* treated as in
  // flight: it should re-iterate, which startPendingReviews handles below.
  if (getActiveReviewRuns(card.id).some((r) => r.status !== "failed")) return [];

  // startPendingReviews de-dups per changeset via shouldStartReview and emits
  // review-injected actions for anything it starts.
  return startPendingReviews(hostUrl, card, "plan->build", riskLevel, changesetRef);
}

/**
 * Plan phase: check if plan review should be triggered.
 */
async function runPlanPipeline(
  hostUrl: string,
  card: KanbanCard,
  riskLevel: RiskLevel,
  changesetRef: string | undefined,
  allCards: KanbanCard[]
): Promise<HeartbeatAction[]> {
  const actions: HeartbeatAction[] = [];
  const config = loadConfig();
  const transition = "plan->build";

  if (!config.orchestrator.autoInjectReviews) return actions;

  const { allowed, pendingGates } = canAdvancePhase(
    card.id,
    "plan",
    "build",
    card.workingDirectory,
    riskLevel,
    changesetRef
  );

  if (allowed) {
    if (config.orchestrator.autoAdvancePhases && canEnterPhase("build", allCards, config)) {
      setCardPhase(card.id, "build");
      const action: HeartbeatAction = { type: "phase-advanced", cardId: card.id, from: "plan", to: "build" };
      emit(action);
      actions.push(action);
    }
    return actions;
  }

  // Check for review gates
  const reviewPending = pendingGates.filter((g) => g.gateType === "review");
  if (reviewPending.length > 0) {
    const activeReviews = getActiveReviewRuns(card.id);
    if (activeReviews.length === 0) {
      // No active reviews — start any that aren't parked on a human escalation.
      actions.push(...(await startPendingReviews(hostUrl, card, transition, riskLevel, changesetRef)));
    } else {
      // Process active reviews (verdict extraction, re-iteration, escalation)
      for (const review of activeReviews) {
        if (review.status === "injected") {
          const sessionUri = card.id;
          const verdict = await processReviewResult(hostUrl, sessionUri, review.id, changesetRef);
          if (verdict.action === "passed") {
            emit({ type: "review-passed", cardId: card.id, skillId: review.skillId });
            actions.push({ type: "review-passed", cardId: card.id, skillId: review.skillId });
            // Same-tick advance: the review just satisfied the last pending gate,
            // so advance plan->build now instead of waiting a full tick. Waiting
            // let a flapping changeset ref re-invalidate the fresh pass and
            // re-inject the review -- the loop this whole change fixes. Re-check
            // gates freshly (other required gates may still be pending).
            const recheck = canAdvancePhase(card.id, "plan", "build", card.workingDirectory, riskLevel, changesetRef);
            if (
              recheck.allowed &&
              config.orchestrator.autoAdvancePhases &&
              canEnterPhase("build", allCards, config)
            ) {
              setCardPhase(card.id, "build");
              const advanced: HeartbeatAction = { type: "phase-advanced", cardId: card.id, from: "plan", to: "build" };
              emit(advanced);
              actions.push(advanced);
            }
          } else if (verdict.action === "escalated") {
            emit({ type: "escalated", cardId: card.id, reason: verdict.summary });
            actions.push({ type: "escalated", cardId: card.id, reason: verdict.summary });
          }
        } else if (review.status === "failed") {
          const skills = getRequiredReviewSkills(transition, riskLevel);
          const skill = skills.find((s) => s.id === review.skillId);
          if (skill) {
            const sessionUri = card.id;
            const { success } = await startReview(hostUrl, sessionUri, card.id, skill, transition, riskLevel, changesetRef);
            if (success) {
              const action: HeartbeatAction = { type: "review-injected", cardId: card.id, skillId: skill.id, iteration: review.iteration + 1 };
              emit(action);
              actions.push(action);
            }
          }
        }
      }
    }
  }

  return actions;
}
async function runReviewPipeline(
  hostUrl: string,
  card: KanbanCard,
  riskLevel: RiskLevel,
  changesetRef: string | undefined,
  allCards: KanbanCard[]
): Promise<HeartbeatAction[]> {
  const actions: HeartbeatAction[] = [];
  const config = loadConfig();
  const transition = "review->ship";

  if (!config.orchestrator.autoInjectReviews) return actions;

  const { allowed, pendingGates } = canAdvancePhase(
    card.id,
    "review",
    "ship",
    card.workingDirectory,
    riskLevel,
    changesetRef
  );

  if (allowed) {
    if (config.orchestrator.autoAdvancePhases && canEnterPhase("ship", allCards, config)) {
      const { advanced, blockedBy } = advanceReviewToShip(card.id, config.coherence);
      if (advanced) {
        state.coherenceBlocked.delete(card.id);
        const action: HeartbeatAction = { type: "phase-advanced", cardId: card.id, from: "review", to: "ship" };
        emit(action);
        actions.push(action);
      } else if (blockedBy.length > 0 && !state.coherenceBlocked.has(card.id)) {
        // Announce the ship-block once (not every tick) until it clears.
        state.coherenceBlocked.add(card.id);
        const row = blockedBy[0];
        const other = row.cardA === card.id ? row.cardB : row.cardA;
        const action: HeartbeatAction = {
          type: "coherence-blocked",
          cardId: card.id,
          reason: `Ship blocked: unresolved coherence conflict with ${other}`,
        };
        emit(action);
        actions.push(action);
      }
    }
    return actions;
  }

  const reviewPending = pendingGates.filter((g) => g.gateType === "review");
  if (reviewPending.length > 0) {
    const activeReviews = getActiveReviewRuns(card.id);
    if (activeReviews.length === 0) {
      // No active reviews — start any that aren't parked on a human escalation.
      actions.push(...(await startPendingReviews(hostUrl, card, transition, riskLevel, changesetRef)));
    } else {
      // Process active reviews (verdict extraction, re-iteration, escalation)
      for (const review of activeReviews) {
        if (review.status === "injected") {
          const sessionUri = card.id;
          const verdict = await processReviewResult(hostUrl, sessionUri, review.id, changesetRef);
          if (verdict.action === "passed") {
            emit({ type: "review-passed", cardId: card.id, skillId: review.skillId });
            actions.push({ type: "review-passed", cardId: card.id, skillId: review.skillId });
          } else if (verdict.action === "escalated") {
            emit({ type: "escalated", cardId: card.id, reason: verdict.summary });
            actions.push({ type: "escalated", cardId: card.id, reason: verdict.summary });
          }
        } else if (review.status === "failed") {
          const skills = getRequiredReviewSkills(transition, riskLevel);
          const skill = skills.find((s) => s.id === review.skillId);
          if (skill) {
            const sessionUri = card.id;
            const { success } = await startReview(hostUrl, sessionUri, card.id, skill, transition, riskLevel, changesetRef);
            if (success) {
              const action: HeartbeatAction = { type: "review-injected", cardId: card.id, skillId: skill.id, iteration: review.iteration + 1 };
              emit(action);
              actions.push(action);
            }
          }
        }
      }
    }
  }

  return actions;
}

function buildNudgeMessage(card: KanbanCard, nudgesSent: number): string {
  if (nudgesSent === 0) {
    return `You seem idle. If you're stuck, please describe what's blocking you. Otherwise, continue working on: ${card.activity || card.title}`;
  }
  if (nudgesSent === 1) {
    return `Still idle. Please provide a status update or continue with your task. If you need help, describe the blocker.`;
  }
  return `This session has been idle for an extended period. Please respond with your current status.`;
}


