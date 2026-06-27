import "server-only";

import { exec } from "node:child_process";

import { getDb } from "@/lib/db/schema";
import { KanbanCard, Phase, RiskLevel, PendingInput } from "@/lib/types";
import { loadConfig } from "./skill-config";
import { getActiveReviewRuns, startReview, processReviewResult, getRequiredReviewSkills, hasPlanRubberDuck, recordPlanRubberDuck } from "./review-executor";
import { canAdvancePhase, setCardPhase, getNextPhase, computeChangesetRef, startGateRun, getGateRunsForCard, completeGateRun } from "./gate-engine";
import { getCardRisk } from "./risk-store";
import { shouldAutoAnswer, autoAnswer } from "./auto-answerer";
import { injectMessage, answerInput, requestPlanChanges } from "@/lib/ahp/session-messenger";

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
  | { type: "plan-rubber-ducked"; cardId: string };

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
}

const state: HeartbeatState = {
  lastTickAt: 0,
  tickCount: 0,
  stuckSince: new Map(),
  nudgeCount: new Map(),
  gateRetryCount: new Map(),
  pipelineStage: new Map(),
  lastWipViolations: new Map(),
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

  return { actions, errors };
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
    }
    return actions;
  }

  const phase = card.phase;
  const changesetRef = computeChangesetRef(card.filesChanged, card.additions, card.deletions, card.modifiedAt);

  // Build phase pipeline: deterministic gates → review skills → auto-advance
  if (phase === "build") {
    const buildActions = await runBuildPipeline(hostUrl, card, riskLevel, changesetRef, config, allCards);
    actions.push(...buildActions);
  }

  // Plan phase: check for plan review gates
  if (phase === "plan") {
    const planActions = await runPlanPipeline(hostUrl, card, riskLevel, changesetRef, allCards);
    actions.push(...planActions);
  }

  // Review phase: check for review skills
  if (phase === "review") {
    const reviewActions = await runReviewPipeline(hostUrl, card, riskLevel, changesetRef, allCards);
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
 * Build phase pipeline: deterministic gates → review skills → auto-advance.
 */
async function runBuildPipeline(
  hostUrl: string,
  card: KanbanCard,
  riskLevel: RiskLevel,
  changesetRef: string,
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
    for (const gate of deterministicPending) {
      // Check if a run already exists for this gate
      const alreadyRunning = existingRuns.find(
        (r) => r.gateType === gate.gateType && r.status === "running" &&
          r.changesetRef === changesetRef
      );
      if (alreadyRunning) continue;

      // Detect stale passed gates that need re-triggering
      const staleRun = existingRuns.find(
        (r) => r.gateType === gate.gateType && r.status === "passed" &&
          changesetRef && r.changesetRef !== changesetRef
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
      // No active reviews — start them
      const skills = getRequiredReviewSkills(transition, riskLevel);
      for (const skill of skills) {
        // Only auto-inject if no prior run exists (or prior failed and needs re-iteration)
        const sessionUri = card.id; // In production, resolve actual session URI
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
            iteration: 1,
          };
          emit(action);
          actions.push(action);
        }
      }
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
    const { success } = await answerInput(hostUrl, card.id, input.requestId, "accept", answers);
    if (success) {
      const action: HeartbeatAction = { type: "plan-approved", cardId: card.id };
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

  const { success } = await requestPlanChanges(
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
  }
  return actions;
}

/**
 * Plan phase: check if plan review should be triggered.
 */
async function runPlanPipeline(
  hostUrl: string,
  card: KanbanCard,
  riskLevel: RiskLevel,
  changesetRef: string,
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
      const skills = getRequiredReviewSkills(transition, riskLevel);
      for (const skill of skills) {
        const sessionUri = card.id;
        const { success } = await startReview(hostUrl, sessionUri, card.id, skill, transition, riskLevel, changesetRef);
        if (success) {
          const action: HeartbeatAction = { type: "review-injected", cardId: card.id, skillId: skill.id, iteration: 1 };
          emit(action);
          actions.push(action);
        }
      }
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
async function runReviewPipeline(
  hostUrl: string,
  card: KanbanCard,
  riskLevel: RiskLevel,
  changesetRef: string,
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
      setCardPhase(card.id, "ship");
      const action: HeartbeatAction = { type: "phase-advanced", cardId: card.id, from: "review", to: "ship" };
      emit(action);
      actions.push(action);
    }
    return actions;
  }

  const reviewPending = pendingGates.filter((g) => g.gateType === "review");
  if (reviewPending.length > 0) {
    const activeReviews = getActiveReviewRuns(card.id);
    if (activeReviews.length === 0) {
      const skills = getRequiredReviewSkills(transition, riskLevel);
      for (const skill of skills) {
        const sessionUri = card.id;
        const { success } = await startReview(hostUrl, sessionUri, card.id, skill, transition, riskLevel, changesetRef);
        if (success) {
          const action: HeartbeatAction = { type: "review-injected", cardId: card.id, skillId: skill.id, iteration: 1 };
          emit(action);
          actions.push(action);
        }
      }
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

/**
 * Execute a gate command asynchronously. Completes the gate run on exit.
 */
function executeGateCommand(runId: number, command: string, cwd: string): void {
  const maxOutput = 64 * 1024;
  try {
    exec(
      command,
      { cwd, timeout: 5 * 60_000, maxBuffer: maxOutput },
      (error, stdout, stderr) => {
        if (error) {
          const output = (stderr || stdout || error.message).slice(0, maxOutput);
          completeGateRun(runId, "failed", output);
        } else {
          const output = (stdout || "All checks passed").slice(0, maxOutput);
          completeGateRun(runId, "passed", output);
        }
      }
    );
  } catch (err) {
    completeGateRun(runId, "failed", err instanceof Error ? err.message : "Failed to start gate command");
  }
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


