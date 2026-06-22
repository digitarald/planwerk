import "server-only";

import { getDb } from "@/lib/db/schema";
import { KanbanCard, Phase, RiskLevel } from "@/lib/types";
import { loadConfig } from "./skill-config";
import { getActiveReviewRuns, startReview, processReviewResult, getRequiredReviewSkills } from "./review-executor";
import { canAdvancePhase, setCardPhase, getNextPhase, computeChangesetRef } from "./gate-engine";
import { getCardRisk } from "./risk-store";
import { shouldAutoAnswer, autoAnswer } from "./auto-answerer";

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
  | { type: "auto-answered"; cardId: string; answer: string };

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
}

const state: HeartbeatState = {
  lastTickAt: 0,
  tickCount: 0,
  stuckSince: new Map(),
  nudgeCount: new Map(),
  gateRetryCount: new Map(),
  pipelineStage: new Map(),
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
 * Core tick logic: scan cards and execute the build-phase pipeline.
 */
async function runTick(hostUrl: string, cards: KanbanCard[]): Promise<HeartbeatTickResult> {
  state.lastTickAt = Date.now();
  state.tickCount++;
  const config = loadConfig();
  const actions: HeartbeatAction[] = [];
  const errors: string[] = [];

  const activeCards = cards.filter((c) => !c.isArchived && c.phase !== "ship" && c.phase !== "define");

  for (const card of activeCards) {
    try {
      const cardActions = await processCard(hostUrl, card, config);
      actions.push(...cardActions);
    } catch (err) {
      errors.push(`${card.id}: ${err instanceof Error ? err.message : String(err)}`);
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

  return { actions, errors };
}

async function processCard(
  hostUrl: string,
  card: KanbanCard,
  config: ReturnType<typeof loadConfig>
): Promise<HeartbeatAction[]> {
  const actions: HeartbeatAction[] = [];
  const storedRisk = getCardRisk(card.id);
  const riskLevel: RiskLevel = storedRisk?.level ?? card.risk ?? "medium";

  // Only process idle cards — running cards are doing work
  if (card.runtime !== "idle") {
    // Auto-answer input-needed cards below risk threshold
    if (card.runtime === "input-needed" && shouldAutoAnswer(card)) {
      const result = await autoAnswer(hostUrl, card);
      if (result.answered) {
        const action: HeartbeatAction = { type: "auto-answered", cardId: card.id, answer: result.answer ?? "" };
        emit(action);
        actions.push(action);
      }
    }
    return actions;
  }

  const phase = card.phase;
  const changesetRef = computeChangesetRef(card.filesChanged, card.additions, card.deletions, card.modifiedAt);

  // Build phase pipeline: deterministic gates → review skills → auto-advance
  if (phase === "build") {
    const buildActions = await runBuildPipeline(hostUrl, card, riskLevel, changesetRef, config);
    actions.push(...buildActions);
  }

  // Plan phase: check for plan review gates
  if (phase === "plan") {
    const planActions = await runPlanPipeline(hostUrl, card, riskLevel, changesetRef);
    actions.push(...planActions);
  }

  // Review phase: check for review skills
  if (phase === "review") {
    const reviewActions = await runReviewPipeline(hostUrl, card, riskLevel, changesetRef);
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
  config: ReturnType<typeof loadConfig>
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
    // Don't auto-run deterministic gates here — the gate-engine handles that
    // We just track the pipeline stage for detection
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
    state.pipelineStage.set(card.id, "advancing");
    const nextPhase = getNextPhase("build");
    if (nextPhase) {
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
 * Plan phase: check if plan review should be triggered.
 */
async function runPlanPipeline(
  hostUrl: string,
  card: KanbanCard,
  riskLevel: RiskLevel,
  changesetRef: string
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
    if (config.orchestrator.autoAdvancePhases) {
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
    }
  }

  return actions;
}

/**
 * Review phase: check for review-to-ship gates.
 */
async function runReviewPipeline(
  hostUrl: string,
  card: KanbanCard,
  riskLevel: RiskLevel,
  changesetRef: string
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
    if (config.orchestrator.autoAdvancePhases) {
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


