import "server-only";

import { AsyncLocalStorage } from "node:async_hooks";

import { getDb } from "@/lib/db/schema";
import { awaitAbortable, isOperationAborted } from "@/lib/abort";
import {
  type KanbanCard,
  type Phase,
  type RiskLevel,
  type PendingInput,
  normalizeChangesetRef,
} from "@/lib/types";
import { loadConfig, type SkillConfig } from "./skill-config";
import { getActiveReviewRuns, getLatestReviewRun, startReview, processReviewResult, getRequiredReviewSkills, isReviewResultReady, shouldStartReview } from "./review-executor";
import { canAdvancePhase, setCardPhase, getNextPhase, startGateRun, getGateRunsForCard, completeGateRun, executeGateCommand } from "./gate-engine";
import { isRetryableGateFailure } from "./gate-command";
import {
  getAuthoritativeCardRisk,
  getAuthoritativeRiskSnapshot,
  persistAuthoritativeRisk,
} from "./risk-store";
import { riskAutomationPolicy } from "./risk-authority";
import { shouldAutoAnswer, autoAnswer } from "./auto-answerer";
import { answerInput, disposePeerChat, submitPlanFeedback } from "@/lib/ahp/session-messenger";
import { syncCoherence } from "./coherence-engine";
import { runCoherenceExecutor, type ReviewCardCtx } from "./coherence-reviewer";
import { advanceReviewToShip } from "./phase-advance";
import { hasReadableArtifact } from "./artifact-gate";
import { selectPendingReviewSkills } from "./plan-gate-selection";
import { retryPendingReviewChatCleanup } from "./review-chat-cleanup";
import { resolveAuthoritativeGateRevision } from "./gate-revision";
import {
  SerializedGenerationScheduler,
  type SchedulerGeneration,
} from "./generation-scheduler";
import {
  coordinatorModeAllows,
  coordinatorReviewPolicy,
  type CoordinatorMode,
} from "./coordinator-mode";
import { getEffectiveCoordinatorMode } from "./coordinator-mode-store";
import { isCardAutomationEligible } from "./automation-eligibility";
import { assessRisk } from "./risk-assessor";
import { reassessAndPersistRisk } from "./risk-reassessment";
import { OperationAdmission } from "./operation-admission";
import {
  assertOperationCurrent,
  getOperationSignal,
  withOperationContext,
} from "./operation-context";

/**
 * Heartbeat action types emitted to the orchestrator feed.
 */
export type HeartbeatAction =
  | { type: "gate-triggered"; cardId: string; gateType: string }
  | { type: "gate-completed"; cardId: string; gateType: string; status: "passed" | "failed" }
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
  | { type: "plan-review-passed"; cardId: string }
  | { type: "plan-feedback-delivered"; cardId: string }
  | { type: "plan-review-failed"; cardId: string; reason: string }
  | { type: "risk-assessed"; cardId: string; level: RiskLevel }
  | { type: "risk-assessment-required"; cardId: string; reason: string }
  | { type: "source-revision-required"; cardId: string; reason: string }
  | { type: "coherence-conflict"; cardId: string; otherCardId: string; summary: string }
  | { type: "coherence-cleared"; cardId: string; otherCardId: string }
  | { type: "coherence-blocked"; cardId: string; reason: string }
  | { type: "wip-cleared"; phase: Phase };

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
  riskBlockers: Map<string, string>; // card → current missing/stale blocker key
  revisionBlockers: Map<string, string>; // card → current source/plan blocker
  mutationBlockers: Set<string>;
}

function createHeartbeatState(): HeartbeatState {
  return {
    lastTickAt: 0,
    tickCount: 0,
    stuckSince: new Map(),
    nudgeCount: new Map(),
    gateRetryCount: new Map(),
    pipelineStage: new Map(),
    lastWipViolations: new Map(),
    coherenceBlocked: new Set(),
    planBusySince: new Map(),
    riskBlockers: new Map(),
    revisionBlockers: new Map(),
    mutationBlockers: new Set(),
  };
}

interface HeartbeatGeneration {
  token: SchedulerGeneration;
  getHosts: () => HeartbeatHostSnapshot[];
  onAction: (hostUrl: string, action: HeartbeatAction) => void;
  hostStates: Map<string, HeartbeatState>;
  hostControllers: Map<string, AbortController>;
  dirty: Map<string, Set<string> | null>;
  lastHost?: string;
  nextRecoveryAt: number;
}

const heartbeatScheduler = new SerializedGenerationScheduler();
const operationAdmission = new OperationAdmission();
let reviewCleanupInFlight: Promise<unknown> | null = null;
const heartbeatGenerationStorage =
  new AsyncLocalStorage<HeartbeatGeneration>();
const heartbeatGenerations =
  new WeakMap<SchedulerGeneration, HeartbeatGeneration>();
let currentHeartbeatGeneration: SchedulerGeneration | null = null;

function stateForHost(
  generation: HeartbeatGeneration,
  hostUrl: string,
): HeartbeatState {
  let state = generation.hostStates.get(hostUrl);
  if (!state) {
    state = createHeartbeatState();
    generation.hostStates.set(hostUrl, state);
  }
  return state;
}

const NO_LOCAL_WORKING_DIRECTORY_PREFIX = "No local working directory available:";

export interface HeartbeatHostSnapshot {
  hostUrl: string;
  cards: KanbanCard[];
}

/**
 * Start the heartbeat loop. Only one loop runs at a time.
 * Returns a stop function.
 */
export function startHeartbeat(
  getHosts: () => HeartbeatHostSnapshot[],
  actionHandler: (hostUrl: string, action: HeartbeatAction) => void
): () => void {
  if (heartbeatScheduler.isRunning()) {
    const existingGeneration = currentHeartbeatGeneration;
    return () => void stopHeartbeat(existingGeneration);
  }

  const config = loadConfig();
  const token = heartbeatScheduler.start({
    intervalMs: config.orchestrator.heartbeatInterval,
    run(scheduledGeneration) {
      const generation = heartbeatGenerations.get(scheduledGeneration);
      if (!generation) return Promise.resolve();
      return heartbeatGenerationStorage.run(
        generation,
        () => runSchedulerTick(generation),
      ).then(() => undefined);
    },
    onError(err) {
      console.warn(
        "[heartbeat] tick error:",
        err instanceof Error ? err.message : err,
      );
    },
  });
  heartbeatGenerations.set(token, {
    token,
    getHosts,
    onAction: actionHandler,
    hostStates: new Map(),
    hostControllers: new Map(),
    dirty: new Map(),
    nextRecoveryAt: 0,
  });
  currentHeartbeatGeneration = token;

  return () => void stopHeartbeat(token);
}

export async function stopHeartbeat(
  generation: SchedulerGeneration | null = currentHeartbeatGeneration,
): Promise<void> {
  if (!generation) return;
  if (currentHeartbeatGeneration === generation) {
    currentHeartbeatGeneration = null;
  }
  await heartbeatScheduler.stop(generation);
  heartbeatGenerations.get(generation)?.hostStates.clear();
  heartbeatGenerations.delete(generation);
}

export function isHeartbeatRunning(): boolean {
  return heartbeatScheduler.isRunning();
}

/** Coalesced event wakeups supplement, rather than replace, periodic recovery. */
export function requestHeartbeatTick(hostUrl?: string, cardId?: string): void {
  const generation = currentHeartbeatGeneration
    ? heartbeatGenerations.get(currentHeartbeatGeneration)
    : undefined;
  if (!generation) return;
  if (!hostUrl) {
    for (const host of generation.getHosts()) generation.dirty.set(host.hostUrl, null);
  } else if (!cardId) {
    generation.dirty.set(hostUrl, null);
  } else if (generation.dirty.get(hostUrl) !== null) {
    const cards = generation.dirty.get(hostUrl) ?? new Set<string>();
    cards.add(cardId);
    generation.dirty.set(hostUrl, cards);
  }
  heartbeatScheduler.requestRun(generation.token);
}

/** Retiring a host revokes old work even if the same URL immediately reconnects. */
export function invalidateHostWork(hostUrl: string): void {
  const generation = currentHeartbeatGeneration
    ? heartbeatGenerations.get(currentHeartbeatGeneration)
    : undefined;
  if (!generation) return;
  generation.hostControllers.get(hostUrl)?.abort();
  generation.hostControllers.delete(hostUrl);
  generation.hostStates.delete(hostUrl);
  requestHeartbeatTick(hostUrl);
}

function emit(hostUrl: string, action: HeartbeatAction): void {
  const generation = heartbeatGenerationStorage.getStore();
  if (
    !generation ||
    !heartbeatScheduler.isCurrent(generation.token) ||
    generation.token.signal.aborted
  ) {
    return;
  }
  if (getOperationSignal()?.aborted) return;
  generation.onAction(hostUrl, action);
  logAction(action);
}

function trackGenerationTask<T>(task: Promise<T>): Promise<T> {
  const generation = heartbeatGenerationStorage.getStore();
  if (!generation) return task;
  return heartbeatScheduler.track(generation.token, task);
}

async function runSchedulerTick(
  generation: HeartbeatGeneration,
): Promise<HeartbeatTickResult[]> {
  const { signal } = generation.token;
  try {
    if (!reviewCleanupInFlight) {
      const cleanup = retryPendingReviewChatCleanup(getDb(), disposePeerChat);
      reviewCleanupInFlight = cleanup;
      const clear = () => {
        if (reviewCleanupInFlight === cleanup) reviewCleanupInFlight = null;
      };
      void cleanup.then(clear, clear);
    }
    await awaitAbortable(
      () => reviewCleanupInFlight!,
      AbortSignal.any([signal, AbortSignal.timeout(1_000)]),
    );
  } catch (error) {
    if (!isOperationAborted(error)) {
      const detail = error instanceof Error ? error.message : String(error);
      console.warn("[heartbeat:review-cleanup] Reconciliation failed:", detail);
    }
  }
  if (signal.aborted) return [];

  const hostsByUrl = new Map<string, Map<string, KanbanCard>>();
  for (const host of generation.getHosts()) {
    const cards = hostsByUrl.get(host.hostUrl) ?? new Map<string, KanbanCard>();
    for (const card of host.cards) cards.set(card.id, card);
    hostsByUrl.set(host.hostUrl, cards);
  }
  const hosts = [...hostsByUrl].map(([hostUrl, cards]) => ({
    hostUrl,
    cards: [...cards.values()],
  }));
  const previousIndex = hosts.findIndex((host) => host.hostUrl === generation.lastHost);
  if (previousIndex >= 0) hosts.push(...hosts.splice(0, previousIndex + 1));
  generation.lastHost = hosts[0]?.hostUrl;
  const recovery = Date.now() >= generation.nextRecoveryAt;
  if (recovery) generation.nextRecoveryAt = Date.now() + loadConfig().orchestrator.heartbeatInterval;
  const dirty = new Map(generation.dirty);
  generation.dirty.clear();
  const results: HeartbeatTickResult[] = [];
  const activeHosts = new Set(hosts.map(({ hostUrl }) => hostUrl));
  for (const hostUrl of generation.hostStates.keys()) {
    if (!activeHosts.has(hostUrl)) {
      generation.hostControllers.get(hostUrl)?.abort();
      generation.hostControllers.delete(hostUrl);
      generation.hostStates.delete(hostUrl);
    }
  }
  for (const { hostUrl, cards } of hosts) {
    if (signal.aborted) break;
    if (!recovery && !dirty.has(hostUrl)) continue;
    if (!generation.hostControllers.has(hostUrl)) {
      generation.hostControllers.set(hostUrl, new AbortController());
    }
    results.push(await runTick(generation, hostUrl, cards, recovery ? null : dirty.get(hostUrl)));
  }
  return results;
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
  const readPhase = getDb().prepare("SELECT phase FROM card_phases WHERE card_id = ?");
  const count = cards.filter((card) => {
    const persisted = readPhase.get(card.id) as { phase: Phase } | undefined;
    return !card.isArchived && (persisted?.phase ?? card.phase) === phase;
  }).length;
  return count < limit;
}

/**
 * Core tick logic: scan cards and execute the build-phase pipeline.
 */
async function runTick(
  generation: HeartbeatGeneration,
  hostUrl: string,
  cards: KanbanCard[],
  dirtyCards?: Set<string> | null,
): Promise<HeartbeatTickResult> {
  const tickHostController = generation.hostControllers.get(hostUrl);
  const state = stateForHost(generation, hostUrl);
  state.lastTickAt = Date.now();
  state.tickCount++;
  const config = loadConfig();
  const actions: HeartbeatAction[] = [];
  const errors: string[] = [];
  // Process non-archived, non-shipped cards. `define` cards are normally
  // skipped, but a brand-new session's plan-approval (and other input requests)
  // can appear while planwerk still has the card in `define`, so include
  // define cards that are waiting on input.
  const activeCards = cards
    .filter(isCardAutomationEligible)
    .filter((card) => {
      if (card.phase === "define") return card.runtime === "input-needed";
      return resolveAuthoritativeGateRevision(
        getDb(),
        card.id,
        card.phase,
        hostUrl,
      ).ok;
    });

  for (const card of activeCards) {
    if (generation.token.signal.aborted) break;
    if (dirtyCards && !dirtyCards.has(card.id)) continue;
    const hostController = generation.hostControllers.get(hostUrl);
    if (!hostController || hostController.signal.aborted) break;
    const lease = operationAdmission.acquire(hostUrl, card.id);
    if (!lease) {
      if (operationAdmission.isQuarantined(hostUrl, card.id) && !state.mutationBlockers.has(card.id)) {
        state.mutationBlockers.add(card.id);
        const action: HeartbeatAction = {
          type: "escalated",
          cardId: card.id,
          reason: "A previous session mutation has an uncertain remote outcome. Automation is paused until confirmed; ambiguous failures require human reconciliation.",
        };
        emit(hostUrl, action);
        actions.push(action);
      }
      continue;
    }
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort("Card operation deadline exceeded."), 60_000);
    const signal = AbortSignal.any([
      generation.token.signal,
      hostController.signal,
      deadline.signal,
    ]);
    const factsDigest = getAuthoritativeRiskSnapshot(hostUrl, card.id)?.digest;
    const expected = {
      phase: card.phase,
      runtime: card.runtime,
      requestId: card.pendingInput?.requestId,
      workingDirectory: card.workingDirectory,
    };
    const isCurrent = (capability: Parameters<typeof coordinatorModeAllows>[1]) => {
      if (!heartbeatScheduler.isCurrent(generation.token)) return false;
      if (generation.hostControllers.get(hostUrl) !== hostController) return false;
      const current = generation.getHosts()
        .filter((host) => host.hostUrl === hostUrl)
        .flatMap((host) => host.cards)
        .find((candidate) => candidate.id === card.id);
      if (
        !current || !isCardAutomationEligible(current) ||
        current.phase !== expected.phase || current.runtime !== expected.runtime ||
        current.pendingInput?.requestId !== expected.requestId ||
        current.workingDirectory !== expected.workingDirectory ||
        !coordinatorModeAllows(getEffectiveCoordinatorMode(hostUrl, card.id), capability) ||
        getAuthoritativeRiskSnapshot(hostUrl, card.id)?.digest !== factsDigest
      ) return false;
      const phase = getDb().prepare("SELECT phase FROM card_phases WHERE card_id = ?")
        .get(card.id) as { phase: string } | undefined;
      return !phase || phase.phase === expected.phase;
    };
    try {
      const cardActions = await awaitAbortable(
        () => withOperationContext(
          { signal, hostUrl, cardId: card.id, lease, isCurrent },
          () => processCard(hostUrl, card, config, cards, state),
        ),
        signal,
      );
      actions.push(...cardActions);
    } catch (err) {
      if (isOperationAborted(err)) continue;
      const msg = `${card.id}: ${err instanceof Error ? err.message : String(err)}`;
      if (process.env.AHP_DEBUG) console.warn("[heartbeat:card-error]", msg);
      errors.push(msg);
    } finally {
      clearTimeout(timer);
      lease.finish();
    }
  }
  if (
    generation.token.signal.aborted ||
    generation.hostControllers.get(hostUrl) !== tickHostController ||
    generation.hostControllers.get(hostUrl)?.signal.aborted ||
    !generation.getHosts().some((host) => host.hostUrl === hostUrl)
  ) return { actions, errors };

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

  // WIP violation detection (board-level, emitted on threshold crossings)
  const wipLimits = config.wipLimits;
  const phaseCount: Record<string, number> = {};
  for (const card of activeCards) {
    phaseCount[card.phase] = (phaseCount[card.phase] ?? 0) + 1;
  }
  for (const [phase, limit] of Object.entries(wipLimits)) {
    const count = phaseCount[phase] ?? 0;
    const lastCount = state.lastWipViolations.get(phase);
    if (count > limit && lastCount === undefined) {
      state.lastWipViolations.set(phase, count);
      const action: HeartbeatAction = { type: "wip-violation", phase: phase as Phase, count, limit };
      emit(hostUrl, action);
      actions.push(action);
    } else if (count > limit) {
      state.lastWipViolations.set(phase, count);
    } else if (count <= limit && lastCount !== undefined) {
      state.lastWipViolations.delete(phase);
      const action: HeartbeatAction = {
        type: "wip-cleared",
        phase: phase as Phase,
      };
      emit(hostUrl, action);
      actions.push(action);
    }
  }

  // Board-level coherence pass (horizontal gate). Deterministic detection + cleanup
  // run here; the LLM review is kicked fire-and-forget so it never blocks the tick.
  if (config.coherence.enabled) {
    try {
      const escalatable = syncCoherence(activeCards, config.coherence, hostUrl).filter((row) =>
        coordinatorModeAllows(
          getEffectiveCoordinatorMode(hostUrl, row.cardA),
          "verify",
        ) &&
        coordinatorModeAllows(
          getEffectiveCoordinatorMode(hostUrl, row.cardB),
          "verify",
        )
      );
      if (escalatable.length > 0) {
        const ctxById = buildCoherenceCtx(cards);
        const hostController = generation.hostControllers.get(hostUrl);
        const sourceDigests = new Map(escalatable.flatMap((row) => [row.cardA, row.cardB])
          .map((cardId) => [cardId, getAuthoritativeRiskSnapshot(hostUrl, cardId)?.digest]));
        const signal = AbortSignal.any([
          generation.token.signal,
          hostController!.signal,
        ]);
        const isCurrent = () => !signal.aborted &&
          heartbeatScheduler.isCurrent(generation.token) &&
          generation.hostControllers.get(hostUrl) === hostController &&
          [...sourceDigests].every(([cardId, digest]) =>
            generation.getHosts().some((host) => host.hostUrl === hostUrl &&
              host.cards.some((card) => card.id === cardId && isCardAutomationEligible(card))) &&
            coordinatorModeAllows(getEffectiveCoordinatorMode(hostUrl, cardId), "verify") &&
            getAuthoritativeRiskSnapshot(hostUrl, cardId)?.digest === digest);
        // Fire-and-forget: reviewer runs off-tick; verdicts are emitted when ready.
        void trackGenerationTask(
          runCoherenceExecutor(hostUrl, escalatable, ctxById, { signal, isCurrent })
            .then((outcomes) => {
              if (!isCurrent()) return;
              for (const o of outcomes) emitCoherenceOutcome(hostUrl, o);
            })
            .catch((err) => {
              if (process.env.AHP_DEBUG) {
                console.warn("[heartbeat:coherence]", err);
              }
            }),
        );
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
function emitCoherenceOutcome(hostUrl: string, o: {
  cardA: string;
  cardB: string;
  status: "conflict" | "coherent" | "needs-human";
  summary: string;
}): void {
  if (o.status === "conflict") {
    emit(hostUrl, { type: "coherence-conflict", cardId: o.cardA, otherCardId: o.cardB, summary: o.summary });
  } else if (o.status === "coherent") {
    emit(hostUrl, { type: "coherence-cleared", cardId: o.cardA, otherCardId: o.cardB });
  } else {
    emit(hostUrl, { type: "coherence-blocked", cardId: o.cardA, reason: o.summary });
  }
}

function kickReviewJudgment(
  hostUrl: string,
  cardId: string,
  skillId: string,
  reviewRunId: number,
  changesetRef: string | undefined
): void {
  void trackGenerationTask(
    processReviewResult(hostUrl, cardId, reviewRunId, changesetRef)
      .then((verdict) => {
        if (!verdict) return;
        if (verdict.action === "passed") {
          emit(hostUrl, { type: "review-passed", cardId, skillId });
        } else if (verdict.action === "escalated") {
          emit(hostUrl, {
            type: "escalated",
            cardId,
            reason: verdict.summary,
          });
        }
      })
      .catch((error) => {
        console.warn(
          `[heartbeat:review] Failed to process review ${reviewRunId}:`,
          error instanceof Error ? error.message : error,
        );
      }),
  );
}

function reviewSkillForMode<T extends { autoFix: boolean }>(
  skill: T,
  coordinatorMode: CoordinatorMode,
): T {
  return coordinatorReviewPolicy(coordinatorMode).allowEdits
    ? skill
    : { ...skill, autoFix: false };
}

function reviewDispatchOptions(
  coordinatorMode: CoordinatorMode,
  pendingRequestId?: string,
): {
  independent: boolean;
  pendingRequestId?: string;
} {
  return {
    independent: coordinatorReviewPolicy(coordinatorMode).independent,
    ...(pendingRequestId ? { pendingRequestId } : {}),
  };
}

function startReviewForMode(
  hostUrl: string,
  sessionUri: string,
  cardId: string,
  skill: SkillConfig,
  transition: string,
  riskLevel: RiskLevel,
  changesetRef: string | undefined,
  coordinatorMode: CoordinatorMode,
  pendingRequestId?: string,
) {
  assertOperationCurrent("verify");
  return startReview(
    hostUrl,
    sessionUri,
    cardId,
    reviewSkillForMode(skill, coordinatorMode),
    transition,
    riskLevel,
    changesetRef,
    {
      ...reviewDispatchOptions(coordinatorMode, pendingRequestId),
      signal: getOperationSignal(),
    },
  );
}

async function completeReadyReviewsAfterDowngrade(
  hostUrl: string,
  card: KanbanCard,
  changesetRef: string | undefined,
): Promise<HeartbeatAction[]> {
  const actions: HeartbeatAction[] = [];
  const activeReviews = getActiveReviewRuns(card.id).filter(
    (review) =>
      review.status === "injected" || review.status === "extracting",
  );
  for (const review of activeReviews) {
    if (!(await isReviewResultReady(hostUrl, review))) continue;
    const verdict = await processReviewResult(
      hostUrl,
      card.id,
      review.id,
      changesetRef,
      card.workingDirectory,
    );
    if (verdict?.action === "passed") {
      const action: HeartbeatAction = {
        type: "review-passed",
        cardId: card.id,
        skillId: review.skillId,
      };
      emit(hostUrl, action);
      actions.push(action);
    } else if (verdict?.action === "escalated") {
      const action: HeartbeatAction = {
        type: "escalated",
        cardId: card.id,
        reason: verdict.summary,
      };
      emit(hostUrl, action);
      actions.push(action);
    }
  }
  return actions;
}

async function processCard(
  hostUrl: string,
  card: KanbanCard,
  config: ReturnType<typeof loadConfig>,
  allCards: KanbanCard[],
  state: HeartbeatState,
): Promise<HeartbeatAction[]> {
  const actions: HeartbeatAction[] = [];
  assertOperationCurrent();
  let authoritativeRisk = getAuthoritativeCardRisk(card.id, hostUrl);
  let riskAssessmentError: string | null = null;
  if (authoritativeRisk.status !== "current") {
    const snapshot = getAuthoritativeRiskSnapshot(hostUrl, card.id);
    if (snapshot) {
      try {
        const assessment = await reassessAndPersistRisk(
          card.id,
          snapshot,
          assessRisk,
          (...args) => {
            assertOperationCurrent();
            return persistAuthoritativeRisk(...args);
          },
        );
        authoritativeRisk = getAuthoritativeCardRisk(card.id, hostUrl);
        if (authoritativeRisk.status === "current") {
          const action: HeartbeatAction = {
            type: "risk-assessed",
            cardId: card.id,
            level: assessment.level,
          };
          emit(hostUrl, action);
          actions.push(action);
        }
      } catch (error) {
        riskAssessmentError =
          error instanceof Error ? error.message : String(error);
      }
    }
  }
  assertOperationCurrent();
  const coordinatorMode = getEffectiveCoordinatorMode(hostUrl, card.id);
  const mayVerify = coordinatorModeAllows(coordinatorMode, "verify");
  const mayInteract = coordinatorModeAllows(coordinatorMode, "interact");
  const riskPolicy = riskAutomationPolicy(authoritativeRisk);
  if (!riskPolicy.current || authoritativeRisk.status !== "current") {
    const blockerKey = [
      authoritativeRisk.status,
      authoritativeRisk.currentDigest ?? "",
      "assessment" in authoritativeRisk
        ? authoritativeRisk.assessment.riskDigest ?? ""
        : "",
    ].join(":");
    if (state.riskBlockers.get(card.id) !== blockerKey) {
      state.riskBlockers.set(card.id, blockerKey);
      const action: HeartbeatAction = {
        type: "risk-assessment-required",
        cardId: card.id,
        reason: riskAssessmentError
          ? `Automatic risk assessment failed: ${riskAssessmentError}. Automation will retry.`
          : `${riskPolicy.reason} Automation will retry when authoritative facts are available.`,
      };
      emit(hostUrl, action);
      actions.push(action);
    }
    return actions;
  }
  state.riskBlockers.delete(card.id);
  const riskLevel: RiskLevel = riskPolicy.level;
  const revision = ["plan", "build", "review"].includes(card.phase)
    ? resolveAuthoritativeGateRevision(getDb(), card.id, card.phase, hostUrl)
    : null;
  if (revision && !revision.ok) {
    state.revisionBlockers.set(card.id, revision.reason);
    return actions;
  }
  state.revisionBlockers.delete(card.id);
  const authoritativeChangesetRef = revision?.ok
    ? revision.changesetRef
    : undefined;

  if (!mayVerify) {
    actions.push(
      ...(await completeReadyReviewsAfterDowngrade(
        hostUrl,
        card,
        authoritativeChangesetRef,
      )),
    );
  }

  // Only process idle cards — running cards are doing work
  if (card.runtime !== "idle") {
    if (card.runtime === "input-needed") {
      const planApproval = detectPlanApproval(card.pendingInput);
      if (planApproval && mayVerify) {
        // Plan-approval inputs are handled by the plan-approval pipeline:
        // auto-approve low risk, force a rubber-duck on un-reviewed medium+ plans.
        const planActions = await runPlanApprovalPipeline(
          hostUrl,
          card,
          card.pendingInput!,
          planApproval,
          config,
          riskLevel,
          authoritativeChangesetRef!,
          authoritativeRisk.currentDigest,
          state,
          coordinatorMode,
        );
        actions.push(...planActions);
      } else if (mayInteract && shouldAutoAnswer(hostUrl, card)) {
        // Regular clarifying question — auto-answer below the risk threshold.
        const result = await autoAnswer(hostUrl, card);
        if (result.answered) {
          const action: HeartbeatAction = { type: "auto-answered", cardId: card.id, answer: result.answer ?? "" };
          emit(hostUrl, action);
          actions.push(action);
        }
      }
    } else if (
      mayVerify &&
      card.runtime === "running" &&
      card.phase === "plan"
    ) {
      // Opt-in: a plan card that's been heads-down coding never idles, so the
      // idle-only plan-review gate would never run. When enabled, inject it via
      // a queued message so the gate still grades before any advance. Key on the
      // plan content, not the code diff (this is a plan review).
      const busyActions = await maybeInjectBusyPlanReview(
        hostUrl,
        card,
        riskLevel,
        authoritativeChangesetRef,
        config,
        state,
        coordinatorMode,
      );
      actions.push(...busyActions);
    }
    return actions;
  }

  const phase = card.phase;
  // Build phase pipeline: deterministic gates → review skills → auto-advance
  if (phase === "build" && mayVerify) {
    const buildActions = await runBuildPipeline(
      hostUrl,
      card,
      riskLevel,
      authoritativeChangesetRef,
      config,
      allCards,
      state,
      coordinatorMode,
    );
    actions.push(...buildActions);
  }

  // Plan phase: check for plan review gates
  if (phase === "plan" && mayVerify) {
    const planActions = await runPlanPipeline(
      hostUrl,
      card,
      riskLevel,
      authoritativeChangesetRef,
      allCards,
      coordinatorMode,
    );
    actions.push(...planActions);
  }

  // Review phase: check for review skills
  if (phase === "review" && mayVerify) {
    const reviewActions = await runReviewPipeline(
      hostUrl,
      card,
      riskLevel,
      authoritativeChangesetRef,
      allCards,
      state,
      coordinatorMode,
    );
    actions.push(...reviewActions);
  }

  // Check for stuck sessions (beyond stale threshold)
  const staleThresholdMs = config.orchestrator.staleThreshold;
  const stuckSince = state.stuckSince.get(card.id);
  if (
    mayInteract &&
    stuckSince &&
    Date.now() - stuckSince > staleThresholdMs
  ) {
    const nudges = state.nudgeCount.get(card.id) ?? 0;
    if (nudges < 3) {
      const msg = buildNudgeMessage(card, nudges);
      // Note: in production this would use the session URI from the card
      // For now, emit the action for the feed
      emit(hostUrl, { type: "nudge-sent", cardId: card.id, message: msg });
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
  changesetRef: string | undefined,
  coordinatorMode: CoordinatorMode,
): Promise<HeartbeatAction[]> {
  const actions: HeartbeatAction[] = [];
  if (!coordinatorModeAllows(coordinatorMode, "verify")) return actions;
  const skills = getRequiredReviewSkills(
    transition,
    riskLevel,
    card.workingDirectory
  ).filter(
    (skill) => shouldStartReview(card.id, skill.id, transition, changesetRef)
  );
  for (const skill of skills) {
    const { success } = await startReviewForMode(
      hostUrl,
      card.id,
      card.id,
      skill,
      transition,
      riskLevel,
      changesetRef,
      coordinatorMode,
    );
    if (success) {
      const action: HeartbeatAction = { type: "review-injected", cardId: card.id, skillId: skill.id, iteration: 1 };
      emit(hostUrl, action);
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
  allCards: KanbanCard[],
  state: HeartbeatState,
  coordinatorMode: CoordinatorMode,
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
    (g) =>
      g.gateType !== "review" &&
      g.gateType !== "artifact" &&
      g.gateType !== "human-approval"
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
        (r) => r.gateType === gate.gateType &&
          (!gate.gateName || r.gateName === gate.gateName) &&
          r.status === "running" &&
          normalizeChangesetRef(r.changesetRef) === currentCodeRef
      );
      if (alreadyRunning) continue;

      // Skip unchanged command failures, but retry infrastructure failures that
      // can recover without a code change (for example after a server restart).
      const alreadyFailed = existingRuns.find(
        (r) => r.gateType === gate.gateType &&
          (!gate.gateName || r.gateName === gate.gateName) &&
          r.status === "failed" &&
          normalizeChangesetRef(r.changesetRef) === currentCodeRef &&
          !isRetryableGateFailure(r.output) &&
          !(card.workingDirectory && r.output?.startsWith(NO_LOCAL_WORKING_DIRECTORY_PREFIX))
      );
      if (alreadyFailed) continue;

      // Detect stale passed gates that need re-triggering
      const staleRun = existingRuns.find(
        (r) => r.gateType === gate.gateType &&
          (!gate.gateName || r.gateName === gate.gateName) &&
          r.status === "passed" &&
          changesetRef && normalizeChangesetRef(r.changesetRef) !== currentCodeRef
      );

      // Start (or re-start) the gate
      assertOperationCurrent("verify");
      const runId = startGateRun({
        cardId: card.id,
        fromPhase: "build",
        toPhase: "review",
        gateType: gate.gateType,
        gateName: gate.gateName,
        changesetRef,
        signal: getOperationSignal(),
      });

      if (staleRun) {
        const action: HeartbeatAction = { type: "stale-gate-invalidated", cardId: card.id, gateType: gate.gateType };
        emit(hostUrl, action);
        actions.push(action);
      } else {
        const action: HeartbeatAction = { type: "gate-triggered", cardId: card.id, gateType: gate.gateType };
        emit(hostUrl, action);
        actions.push(action);
      }

      // Execute the gate command if available, otherwise fail explicitly.
      if (gate.command && card.workingDirectory) {
        executeGateCommand(runId, gate.command, card.workingDirectory, (status) => {
          emit(hostUrl, { type: "gate-completed", cardId: card.id, gateType: gate.gateType, status });
        }, {
          signal: getOperationSignal(),
          isCurrent() {
            try {
              assertOperationCurrent("verify");
              return true;
            } catch {
              return false;
            }
          },
        });
      } else if (gate.command) {
        completeGateRun(
          runId,
          "failed",
          `${NO_LOCAL_WORKING_DIRECTORY_PREFIX} select a single local workspace root`,
        );
        emit(hostUrl, { type: "gate-completed", cardId: card.id, gateType: gate.gateType, status: "failed" });
      } else {
        completeGateRun(runId, "failed", `No command configured for ${gate.gateName ?? gate.gateType}`);
        emit(hostUrl, { type: "gate-completed", cardId: card.id, gateType: gate.gateType, status: "failed" });
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
      actions.push(...(await startPendingReviews(
        hostUrl,
        card,
        transition,
        riskLevel,
        changesetRef,
        coordinatorMode,
      )));
    } else {
      // Active reviews exist — handle based on status
      for (const review of activeReviews) {
        if (review.status === "injected" || review.status === "extracting") {
          kickReviewJudgment(
            hostUrl,
            card.id,
            review.skillId,
            review.id,
            changesetRef
          );
        } else if (review.status === "failed") {
          // Failed review needs re-injection (re-iteration)
          const skills = getRequiredReviewSkills(
            transition,
            riskLevel,
            card.workingDirectory
          );
          const skill = skills.find((s) => s.id === review.skillId);
          if (skill) {
            const sessionUri = card.id;
            const { success } = await startReviewForMode(
              hostUrl,
              sessionUri,
              card.id,
              skill,
              transition,
              riskLevel,
              changesetRef,
              coordinatorMode,
            );
            if (success) {
              const action: HeartbeatAction = {
                type: "review-injected",
                cardId: card.id,
                skillId: skill.id,
                iteration: review.iteration + 1,
              };
              emit(hostUrl, action);
              actions.push(action);
            }
          }
        }
      }
    }
    return actions;
  }

  // Step 3: All gates pass (including reviews) → auto-advance
  if (
    gatesPassed &&
    config.orchestrator.autoAdvancePhases &&
    coordinatorModeAllows(coordinatorMode, "advance")
  ) {
    const nextPhase = getNextPhase("build");
    if (nextPhase && canEnterPhase(nextPhase, allCards, config)) {
      state.pipelineStage.set(card.id, "advancing");
      assertOperationCurrent("advance");
      setCardPhase(card.id, nextPhase);
      const action: HeartbeatAction = { type: "phase-advanced", cardId: card.id, from: "build", to: nextPhase };
      emit(hostUrl, action);
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
  // Authentication and host-tool safety input must never be interpreted as a
  // plan approval, regardless of any coincidental select options.
  if (input.kind && input.kind !== "elicitation") return null;
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

function readStoredReviewFindings(json: string | null): string[] | null {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json) as unknown;
    return Array.isArray(parsed) && parsed.every((finding) => typeof finding === "string")
      ? parsed
      : null;
  } catch (error) {
    console.warn(
      "[heartbeat:plan-review] Invalid stored findings:",
      error instanceof Error ? error.message : error,
    );
    return null;
  }

}

function formatPlanGateFeedback(
  reviews: Array<{ skillId: string; summary: string; findings: string[] }>,
): string {
  const sections = reviews.map((review) => {
    const findings = review.findings.map((finding) => `- ${finding}`).join("\n");
    return [`[${review.skillId}] ${review.summary}`, findings].filter(Boolean).join("\n");
  });
  return [
    "Configured plan gates found blockers that must be addressed before implementation:",
    "",
    sections.join("\n\n"),
    "",
    "Revise plan.md to address these findings, then present the plan for approval again.",
  ].join("\n");
}

/**
 * Plan-approval pipeline for input-needed cards sitting on a copilotcli
 * plan-approval:
 * - Resolve required plan->build review gates from project YAML.
 * - Run configured review commands in peer chats of the owning session.
 * - Return gate findings as feedback on the original plan request.
 * - Approve a passing gated plan only when risk policy permits it.
 */
async function runPlanApprovalPipeline(
  hostUrl: string,
  card: KanbanCard,
  input: PendingInput,
  approval: { questionId: string; approveOptionId: string },
  config: ReturnType<typeof loadConfig>,
  riskLevel: RiskLevel,
  changesetRef: string,
  riskDigest: string,
  state: HeartbeatState,
  coordinatorMode: CoordinatorMode,
): Promise<HeartbeatAction[]> {
  const actions: HeartbeatAction[] = [];

  const riskStillCurrent = (): boolean => {
    const currentRisk = getAuthoritativeCardRisk(card.id, hostUrl);
    if (
      currentRisk.status === "current" &&
      currentRisk.currentDigest === riskDigest
    ) {
      return true;
    }
    const blockerKey = [
      currentRisk.status,
      currentRisk.currentDigest ?? "",
      "assessment" in currentRisk
        ? currentRisk.assessment.riskDigest ?? ""
        : "",
    ].join(":");
    if (state.riskBlockers.get(card.id) !== blockerKey) {
      state.riskBlockers.set(card.id, blockerKey);
      const action: HeartbeatAction = {
        type: "risk-assessment-required",
        cardId: card.id,
        reason:
          "Risk facts or assessment changed during plan review. Reassess risk before plan approval can continue.",
      };
      emit(hostUrl, action);
      actions.push(action);
    }
    return false;
  };

  const approvePlan = async (): Promise<void> => {
    if (!riskStillCurrent()) return;
    assertOperationCurrent("interact");
    const answers = {
      [approval.questionId]: {
        state: "submitted",
        value: { kind: "selected", value: approval.approveOptionId },
      },
    };
    // Only consumption confirms approval. Never retry an unconfirmed mutation:
    // the host may already have accepted it even though confirmation failed.
    const result = await answerInput(
      hostUrl, card.id, input.requestId, "accept", answers, { signal: getOperationSignal() });

    if (result.success) {
      const action: HeartbeatAction = { type: "plan-approved", cardId: card.id };
      emit(hostUrl, action);
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
      emit(hostUrl, action);
      actions.push(action);
    }
  };

  if (!riskStillCurrent()) return actions;
  const policy = config.reviewPolicy[riskLevel];
  const planRef = normalizeChangesetRef(changesetRef);
  if (!planRef) {
    const action: HeartbeatAction = {
      type: "plan-review-failed",
      cardId: card.id,
      reason: "The current plan hash is unavailable; human review is required.",
    };
    emit(hostUrl, action);
    actions.push(action);
    return actions;
  }

  const transition = "plan->build";
  const { allowed, pendingGates } = canAdvancePhase(
    card.id,
    "plan",
    "build",
    card.workingDirectory,
    riskLevel,
    planRef,
  );
  if (allowed) {
    if (
      policy.autoApprovePlan &&
      coordinatorModeAllows(coordinatorMode, "interact")
    ) {
      await approvePlan();
    }
    return actions;
  }

  const configuredSkills = getRequiredReviewSkills(
    transition,
    riskLevel,
    card.workingDirectory,
  );
  const selection = selectPendingReviewSkills(pendingGates, configuredSkills);
  if (selection.nonReviewNames.length > 0) {
    const action: HeartbeatAction = {
      type: "plan-review-failed",
      cardId: card.id,
      reason: `Required plan gates are pending outside the review pipeline: ${selection.nonReviewNames.join(", ")}.`,
    };
    emit(hostUrl, action);
    actions.push(action);
    return actions;
  }
  const skills = selection.skills;
  if (selection.missingReviewNames.length > 0) {
    const action: HeartbeatAction = {
      type: "plan-review-failed",
      cardId: card.id,
      reason: `Configured review skills are unavailable: ${selection.missingReviewNames.join(", ")}.`,
    };
    emit(hostUrl, action);
    actions.push(action);
    return actions;
  }

  let processedPass = false;
  for (const skill of skills) {
    const latest = getLatestReviewRun(card.id, skill.id, transition);
    const fresh = latest
      && normalizeChangesetRef(latest.changesetRef ?? undefined) === planRef;
    if (latest?.status === "ambiguous") {
      continue;
    }
    if (latest && fresh && (latest.status === "injected" || latest.status === "extracting")) {
      if (await isReviewResultReady(hostUrl, latest)) {
        const verdict = await processReviewResult(
          hostUrl,
          card.id,
          latest.id,
          planRef,
          card.workingDirectory,
        );
        processedPass ||= verdict?.action === "passed";
      }
      continue;
    }
    if (latest && fresh) continue;
    if (!config.orchestrator.autoInjectReviews) continue;
    if (!riskStillCurrent()) return actions;

    const { success } = await startReviewForMode(
      hostUrl,
      card.id,
      card.id,
      skill,
      transition,
      riskLevel,
      planRef,
      coordinatorMode,
      input.requestId,
    );
    if (success) {
      const action: HeartbeatAction = {
        type: "review-injected",
        cardId: card.id,
        skillId: skill.id,
        iteration: getLatestReviewRun(card.id, skill.id, transition)?.iteration ?? 1,
      };
      emit(hostUrl, action);
      actions.push(action);
    } else {
      const failed = getLatestReviewRun(card.id, skill.id, transition);
      const action: HeartbeatAction = {
        type: "plan-review-failed",
        cardId: card.id,
        reason: failed?.verdictSummary ?? `Failed to start configured review gate ${skill.id}.`,
      };
      emit(hostUrl, action);
      actions.push(action);
    }
  }

  const refreshed = skills.map((skill) => ({
    skill,
    run: getLatestReviewRun(card.id, skill.id, transition),
  }));
  const stillRunning = refreshed.some(
    ({ run }) => run && (run.status === "injected" || run.status === "extracting"),
  );
  if (stillRunning) return actions;
  if (!riskStillCurrent()) return actions;

  const passing = canAdvancePhase(
    card.id,
    "plan",
    "build",
    card.workingDirectory,
    riskLevel,
    planRef,
  ).allowed;
  if (passing) {
    if (processedPass) {
      const action: HeartbeatAction = { type: "plan-review-passed", cardId: card.id };
      emit(hostUrl, action);
      actions.push(action);
    }
    if (
      policy.autoApprovePlan &&
      coordinatorModeAllows(coordinatorMode, "interact")
    ) {
      await approvePlan();
    }
    return actions;
  }

  const blocking = refreshed.flatMap(({ skill, run }) => {
    if (!run || run.status !== "failed") return [];
    const findings = readStoredReviewFindings(run.findingsJson);
    if (!findings || findings.length === 0) return [];
    return [{
      skillId: skill.id,
      summary: run.verdictSummary ?? "Configured review gate failed.",
      findings,
    }];
  });
  if (blocking.length === 0) return actions;

  if (!coordinatorModeAllows(coordinatorMode, "interact")) return actions;

  const feedback = formatPlanGateFeedback(blocking);
  assertOperationCurrent("interact");
  const result = await submitPlanFeedback(
    hostUrl,
    card.id,
    input.requestId,
    approval.questionId,
    approval.approveOptionId,
    feedback,
  );

  if (result.success) {
    const action: HeartbeatAction = { type: "plan-feedback-delivered", cardId: card.id };
    emit(hostUrl, action);
    actions.push(action);
  } else if (!result.stale) {
    const action: HeartbeatAction = {
      type: "plan-review-failed",
      cardId: card.id,
      reason: "Review findings were generated but the host did not consume the plan feedback.",
    };
    emit(hostUrl, action);
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
  config: ReturnType<typeof loadConfig>,
  state: HeartbeatState,
  coordinatorMode: CoordinatorMode,
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
  return startPendingReviews(
    hostUrl,
    card,
    "plan->build",
    riskLevel,
    changesetRef,
    coordinatorMode,
  );
}

/**
 * Plan phase: check if plan review should be triggered.
 */
async function runPlanPipeline(
  hostUrl: string,
  card: KanbanCard,
  riskLevel: RiskLevel,
  changesetRef: string | undefined,
  allCards: KanbanCard[],
  coordinatorMode: CoordinatorMode,
): Promise<HeartbeatAction[]> {
  const actions: HeartbeatAction[] = [];
  const config = loadConfig(card.workingDirectory);
  const transition = "plan->build";

  const { allowed, pendingGates } = canAdvancePhase(
    card.id,
    "plan",
    "build",
    card.workingDirectory,
    riskLevel,
    changesetRef
  );

  if (allowed) {
    if (
      config.orchestrator.autoAdvancePhases &&
      coordinatorModeAllows(coordinatorMode, "advance") &&
      canEnterPhase("build", allCards, config)
    ) {
      assertOperationCurrent("advance");
      setCardPhase(card.id, "build");
      const action: HeartbeatAction = { type: "phase-advanced", cardId: card.id, from: "plan", to: "build" };
      emit(hostUrl, action);
      actions.push(action);
    }
    return actions;
  }

  // Check for review gates
  const reviewPending = pendingGates.filter((g) => g.gateType === "review");
  if (reviewPending.length > 0 && config.orchestrator.autoInjectReviews) {
    const activeReviews = getActiveReviewRuns(card.id);
    if (activeReviews.length === 0) {
      // No active reviews — start any that aren't parked on a human escalation.
      actions.push(...(await startPendingReviews(
        hostUrl,
        card,
        transition,
        riskLevel,
        changesetRef,
        coordinatorMode,
      )));
    } else {
      // Process active reviews (verdict extraction, re-iteration, escalation)
      for (const review of activeReviews) {
        if (review.status === "injected" || review.status === "extracting") {
          kickReviewJudgment(
            hostUrl,
            card.id,
            review.skillId,
            review.id,
            changesetRef
          );
        } else if (review.status === "failed") {
          const skills = getRequiredReviewSkills(
            transition,
            riskLevel,
            card.workingDirectory
          );
          const skill = skills.find((s) => s.id === review.skillId);
          if (skill) {
            const sessionUri = card.id;
            const { success } = await startReviewForMode(
              hostUrl,
              sessionUri,
              card.id,
              skill,
              transition,
              riskLevel,
              changesetRef,
              coordinatorMode,
            );
            if (success) {
              const action: HeartbeatAction = { type: "review-injected", cardId: card.id, skillId: skill.id, iteration: review.iteration + 1 };
              emit(hostUrl, action);
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
  allCards: KanbanCard[],
  state: HeartbeatState,
  coordinatorMode: CoordinatorMode,
): Promise<HeartbeatAction[]> {
  const actions: HeartbeatAction[] = [];
  const config = loadConfig(card.workingDirectory);
  const transition = "review->ship";

  const { allowed, pendingGates } = canAdvancePhase(
    card.id,
    "review",
    "ship",
    card.workingDirectory,
    riskLevel,
    changesetRef
  );

  const artifactPending = pendingGates.filter(
    (gate) => gate.gateType === "artifact" && gate.artifactType
  );
  for (const gate of artifactPending) {
    if (!hasReadableArtifact(card.artifacts, gate.artifactType!)) continue;
    assertOperationCurrent("verify");
    const runId = startGateRun({
      cardId: card.id,
      fromPhase: "review",
      toPhase: "ship",
      gateType: "artifact",
      gateName: gate.gateName,
      changesetRef,
    });
    completeGateRun(
      runId,
      "passed",
      `Readable ${gate.artifactType}.md artifact found`
    );
    const action: HeartbeatAction = {
      type: "gate-completed",
      cardId: card.id,
      gateType: "artifact",
      status: "passed",
    };
    emit(hostUrl, action);
    actions.push(action);
  }
  if (allowed) {
    if (
      config.orchestrator.autoAdvancePhases &&
      coordinatorModeAllows(coordinatorMode, "advance") &&
      canEnterPhase("ship", allCards, config)
    ) {
      assertOperationCurrent("advance");
      const { advanced, blockedBy } = advanceReviewToShip(card.id, config.coherence, hostUrl);
      if (advanced) {
        state.coherenceBlocked.delete(card.id);
        const action: HeartbeatAction = { type: "phase-advanced", cardId: card.id, from: "review", to: "ship" };
        emit(hostUrl, action);
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
        emit(hostUrl, action);
        actions.push(action);
      }
    }
    return actions;
  }

  const reviewPending = pendingGates.filter((g) => g.gateType === "review");
  if (reviewPending.length > 0 && config.orchestrator.autoInjectReviews) {
    const activeReviews = getActiveReviewRuns(card.id);
    if (activeReviews.length === 0) {
      // No active reviews — start any that aren't parked on a human escalation.
      actions.push(...(await startPendingReviews(
        hostUrl,
        card,
        transition,
        riskLevel,
        changesetRef,
        coordinatorMode,
      )));
    } else {
      // Process active reviews (verdict extraction, re-iteration, escalation)
      for (const review of activeReviews) {
        if (review.status === "injected" || review.status === "extracting") {
          kickReviewJudgment(
            hostUrl,
            card.id,
            review.skillId,
            review.id,
            changesetRef
          );
        } else if (review.status === "failed") {
          const skills = getRequiredReviewSkills(
            transition,
            riskLevel,
            card.workingDirectory
          );
          const skill = skills.find((s) => s.id === review.skillId);
          if (skill) {
            const sessionUri = card.id;
            const { success } = await startReviewForMode(
              hostUrl,
              sessionUri,
              card.id,
              skill,
              transition,
              riskLevel,
              changesetRef,
              coordinatorMode,
            );
            if (success) {
              const action: HeartbeatAction = { type: "review-injected", cardId: card.id, skillId: skill.id, iteration: review.iteration + 1 };
              emit(hostUrl, action);
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
