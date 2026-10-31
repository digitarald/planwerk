import "server-only";

import { createHash, randomUUID } from "node:crypto";

import { injectMessage } from "@/lib/ahp/session-messenger";
import { startReview } from "./review-executor";
import { getApplicableSkills, loadConfig } from "./skill-config";
import {
  completeGateRun,
  executeGateCommand,
  getGateRunsForCard,
  getNextPhase,
  getPersistedCardPhase,
  resolveConfiguredGate,
  startGateRun,
  setCardPhase,
  type GateType,
} from "./gate-engine";
import { assessRisk } from "./risk-assessor";
import type { OrchestratorToolName, ToolCallResult } from "./orchestrator-tools";
import { PHASE_ORDER, type KanbanCard, type Phase } from "@/lib/types";
import {
  getAuthoritativeRiskSnapshot,
  getRiskForAutomation,
  persistAuthoritativeRisk,
} from "./risk-store";
import { getCtoContinuityStore } from "@/lib/db/cto-continuity";
import { getDb } from "@/lib/db/schema";
import {
  authorizeAndRunOverride,
  getAuthoritativeApprovalBinding as readAuthoritativeApprovalBinding,
} from "./cto-override-authorization";
import type { CtoContinuityStore } from "@/lib/db/cto-continuity-store";
import {
  persistToolHandlerOutcome,
  toolLeaseFailureOutcome,
  type ToolHandlerOutcome,
} from "./tool-execution-disposition";
import { isOperationAborted } from "@/lib/abort";
import { runLeaseRenewalTick } from "./lease-renewal";
import { reassessAndPersistRisk } from "./risk-reassessment";
import type { RiskFactsSnapshot } from "./risk-facts";
import { createAndStartSession } from "../ahp/create-session";
import { currentCoordinatorCards, withCoordinatorAuthority } from "./coordinator-authority";
import { queryCoordinatorSessions } from "./coordinator-queries";
import { coordinatorReviewPolicy } from "./coordinator-mode";
import { getEffectiveCoordinatorMode } from "./coordinator-mode-store";
import { assertOperationCurrent, runOperationEffect } from "./operation-context";
import { submitAuthorizedAnswer } from "./auto-answerer";
import { getCoordinatorGoalStore, goalInScope, listCoordinatorGoals, manageCoordinatorGoal } from "./coordinator-goal-service";
import { resolveAuthoritativeGateRevision } from "./gate-revision";
import { recordCoordinatorDelivery, getCoordinatorDelivery } from "../db/coordinator-deliveries";

const TOOL_EXECUTION_LEASE_MS = 5 * 60_000;

interface RenewalScheduler {
  set(callback: () => void, delayMs: number): unknown;
  clear(handle: unknown): void;
}

const defaultRenewalScheduler: RenewalScheduler = {
  set(callback, delayMs) {
    const timer = setInterval(callback, delayMs);
    timer.unref();
    return timer;
  },
  clear(handle) {
    clearInterval(handle as ReturnType<typeof setInterval>);
  },
};

export interface ToolCallContext {
  hostUrl: string;
  workspaceScope: string[];
  cards: KanbanCard[];
  idempotencyKey: string;
  sdkSessionId: string;
  toolCallId: string;
  signal?: AbortSignal;
  isCurrent?: () => boolean;
  services?: {
    continuityStore?: CtoContinuityStore;
    startReview?: typeof startReview;
    executeGateCommand?: typeof executeGateCommand;
    injectMessage?: (
      ...args: Parameters<typeof injectMessage>
    ) => Promise<{ success: boolean; queued?: boolean; chatUri?: string; turnId?: string }>;
    assessRisk?: typeof assessRisk;
    getAuthoritativeRiskSnapshot?: (
      hostUrl: string,
      cardId: string,
    ) => RiskFactsSnapshot | null;
    persistRisk?: typeof persistAuthoritativeRisk;
    renewalScheduler?: RenewalScheduler;
    toolExecutionLeaseMs?: number;
  };
}

export function getAuthoritativeApprovalBinding(
  toolName: string,
  args: Record<string, unknown>,
  sdkSessionId: string
) {
  return readAuthoritativeApprovalBinding(
    toolName,
    args,
    sdkSessionId,
    getDb()
  );
}

function abortedResult(): ToolCallResult {
  return {
    success: false,
    message: "Tool execution was cancelled before the action started.",
  };
}

function needsHumanRecoveryResult(toolName: string): ToolCallResult {
  return {
    success: false,
    message:
      `A previous ${toolName} attempt ended after its side effect became ` +
      "ambiguous. Human review is required before retrying.",
  };
}

function coordinatorSessionResource(key: string): string {
  const digest = createHash("sha256").update(key).digest("hex");
  return `ahp-session:/${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

/**
 * Execute an orchestrator tool call and return the result.
 */
export async function executeToolCall(
  toolName: OrchestratorToolName,
  args: Record<string, unknown>,
  context: ToolCallContext
): Promise<ToolCallResult> {
  if (context.signal?.aborted || context.isCurrent?.() === false) {
    return { ...abortedResult(), auditKey: context.idempotencyKey };
  }
  const scope = { hostUrl: context.hostUrl, workspaceScope: context.workspaceScope, isCurrent: context.isCurrent };
  if (toolName === "list_goals") {
    return { success: true, message: "Persistent scoped goals; read_goal supplies acceptance criteria and work evidence.", data: listCoordinatorGoals(scope).map((goal) => ({
      id: goal.id, revision: goal.revision, state: goal.state, objective: goal.objective.slice(0, 500),
      summary: goal.summary, workCount: goal.items.length,
    })) };
  }
  if (toolName === "read_goal") {
    const goal = getCoordinatorGoalStore().get(String(args.goalId));
    return goal && goalInScope(goal, scope)
      ? { success: true, message: "Current goal and work evidence.", data: goal }
      : { success: false, message: "Goal is unavailable in this scope." };
  }
  if (toolName === "manage_goal") {
    return { success: true, message: "Goal updated; background effects still require Coordinate and current scope.", data: manageCoordinatorGoal(scope, args, context.idempotencyKey) };
  }
  if (toolName === "list_sessions" || toolName === "read_session" || toolName === "read_session_messages") {
    return queryCoordinatorSessions(toolName, args, context.hostUrl, currentCoordinatorCards(scope));
  }
  const resource = coordinatorSessionResource(context.idempotencyKey);
  return withCoordinatorAuthority(
    scope,
    toolName === "create_session"
      ? { workingDirectory: String(args.workingDirectory ?? ""), resource }
      : { cardId: String(args.cardId ?? "") },
    toolName === "trigger_gate" || toolName === "trigger_review" ? "verify"
      : toolName === "assess_risk" ? "observe"
      : toolName === "override_phase" ? "advance" : "interact",
    context.signal,
    (cards) => executeAdmittedToolCall(toolName, args, { ...context, cards }),
  );
}

async function executeAdmittedToolCall(
  toolName: OrchestratorToolName,
  args: Record<string, unknown>,
  context: ToolCallContext,
): Promise<ToolCallResult> {
  if (context.signal?.aborted) {
    return { ...abortedResult(), auditKey: context.idempotencyKey };
  }
  const store = context.services?.continuityStore ?? getCtoContinuityStore();
  const leaseMs =
    context.services?.toolExecutionLeaseMs ?? TOOL_EXECUTION_LEASE_MS;
  const ownerId = randomUUID();
  const claim = store.claimToolExecution<ToolCallResult>(
    context.idempotencyKey,
    toolName,
    args,
    ownerId,
    leaseMs
  );
  if (claim.state === "completed" || claim.state === "needs-human") {
    return claim.result;
  }
  if (claim.state === "in-progress") {
    return {
      success: false,
      message: `This action is already in progress; retry after ${new Date(claim.leaseExpiresAtMs).toISOString()}.`,
      auditKey: context.idempotencyKey,
    };
  }
  if (claim.state === "recovery-required") {
    const overrideAlreadyApplied =
      toolName === "override_phase" &&
      typeof args.cardId === "string" &&
      typeof args.targetPhase === "string" &&
      (getDb().prepare(
        "SELECT phase FROM card_phases WHERE card_id = ?"
      ).get(args.cardId) as { phase: string } | undefined)?.phase ===
        args.targetPhase;
    if (overrideAlreadyApplied) {
      if (!store.recoverToolExecution(
        context.idempotencyKey,
        ownerId,
        leaseMs
      )) {
        return {
          ...needsHumanRecoveryResult(toolName),
          auditKey: context.idempotencyKey,
        };
      }
      const result = {
        success: true,
        message:
          `Reconciled prior override: ${args.cardId} is already in ${args.targetPhase}.`,
        auditKey: context.idempotencyKey,
      };
      store.completeToolExecution(context.idempotencyKey, ownerId, result);
      return result;
    }
    if (toolName === "assess_risk") {
      if (!store.recoverToolExecution(
        context.idempotencyKey,
        ownerId,
        leaseMs
      )) {
        return {
          ...needsHumanRecoveryResult(toolName),
          auditKey: context.idempotencyKey,
        };
      }
    } else {
      const result = {
        ...needsHumanRecoveryResult(toolName),
        auditKey: context.idempotencyKey,
      };
      store.markToolExecutionNeedsHuman(context.idempotencyKey, result);
      return result;
    }
  }

  if (context.signal?.aborted) {
    store.abandonToolExecution(context.idempotencyKey, ownerId);
    return { ...abortedResult(), auditKey: context.idempotencyKey };
  }
  const scheduler =
    context.services?.renewalScheduler ?? defaultRenewalScheduler;
  const operationAbort = new AbortController();
  const forwardAbort = () => operationAbort.abort(context.signal?.reason);
  context.signal?.addEventListener("abort", forwardAbort, { once: true });
  const leaseState: { failure?: unknown } = {};
  const renewalTimer = scheduler.set(() => {
    runLeaseRenewalTick(
      leaseState,
      () => store.renewToolExecution(
        context.idempotencyKey,
        ownerId,
        leaseMs,
      ),
      (error) => operationAbort.abort(error),
      "Tool execution lease ownership was lost.",
    );
  }, Math.max(1, Math.floor(leaseMs / 3)));
  try {
    const outcome = await executeToolCallOnce(toolName, args, {
      ...context,
      signal: operationAbort.signal,
    });
    if (leaseState.failure !== undefined) throw leaseState.failure;
    const result = {
      ...outcome.result,
      auditKey: context.idempotencyKey,
      data: toolName === "create_session" || toolName === "send_message"
        ? { ...getCoordinatorDelivery(getDb(), context.idempotencyKey), disposition: "uncertain" }
        : outcome.result.data,
    };
    persistToolHandlerOutcome(
      store,
      context.idempotencyKey,
      ownerId,
      { ...outcome, result }
    );
    return result;
  } catch (error) {
    if (leaseState.failure !== undefined) {
      const outcome = toolLeaseFailureOutcome(toolName, leaseState.failure);
      const result = {
        ...outcome.result,
        auditKey: context.idempotencyKey,
      };
      try {
        persistToolHandlerOutcome(store, context.idempotencyKey, ownerId, {
          ...outcome,
          result,
        });
      } catch (persistenceError) {
        console.warn(
          "[tool-executor] Failed to persist lease-loss disposition:",
          persistenceError instanceof Error
            ? persistenceError.message
            : persistenceError,
        );
      }
      return result;
    }
    if (isOperationAborted(error) && toolName !== "create_session" && toolName !== "send_message") {
      store.abandonToolExecution(context.idempotencyKey, ownerId);
      return { ...abortedResult(), auditKey: context.idempotencyKey };
    }
    let result: ToolCallResult = {
      success: false,
      message:
        `Tool execution failed: ${error instanceof Error ? error.message : String(error)}`,
      auditKey: context.idempotencyKey,
      data: toolName === "create_session" || toolName === "send_message"
        ? { ...getCoordinatorDelivery(getDb(), context.idempotencyKey), disposition: "uncertain" } : undefined,
    };
    if (toolName === "assess_risk") {
      store.abandonToolExecution(context.idempotencyKey, ownerId);
    } else {
      result = {
        ...result,
        message:
          `${result.message} The side effect may have occurred; human review is required before retrying.`,
      };
      store.markOwnedToolExecutionNeedsHuman(
        context.idempotencyKey,
        ownerId,
        result
      );
    }
    return result;
  } finally {
    scheduler.clear(renewalTimer);
    context.signal?.removeEventListener("abort", forwardAbort);
  }
}

async function executeToolCallOnce(
  toolName: OrchestratorToolName,
  args: Record<string, unknown>,
  context: ToolCallContext
): Promise<ToolHandlerOutcome> {
  if (context.signal?.aborted) {
    return { result: abortedResult(), disposition: "retryable" };
  }
  let result: ToolCallResult;
  switch (toolName) {
    case "create_session":
      result = await handleCreateSession(args, context);
      break;
    case "send_message":
      result = await handleSendMessage(args, context);
      break;
    case "answer_input":
      result = await handleAnswerInput(args, context);
      break;
    case "trigger_review":
      return await handleTriggerReview(args, context);
    case "trigger_gate":
      return await handleTriggerGate(args, context);
    case "override_phase":
      result = await handleOverridePhase(args, context);
      break;
    case "assess_risk":
      result = await handleAssessRisk(args, context);
      break;
    default:
      result = { success: false, message: `Unknown tool: ${toolName}` };
  }
  return { result, disposition: "terminal" };
}

async function handleCreateSession(args: Record<string, unknown>, context: ToolCallContext): Promise<ToolCallResult> {
  const title = args.title as string;
  if (!title) return { success: false, message: "title is required" };

  const resource = coordinatorSessionResource(context.idempotencyKey);
  recordCoordinatorDelivery(getDb(), context.idempotencyKey, { resource });
  const delivery = await createAndStartSession({
    hostUrl: context.hostUrl, task: args.prompt as string,
    workingDirectory: args.workingDirectory as string, resource, signal: context.signal,
    beforeDispatch: (identity) => recordCoordinatorDelivery(getDb(), context.idempotencyKey,
      deliveryIdentity(resource, identity)),
  });
  return {
    success: delivery.success,
    message: delivery.success ? `Created ${title}; task ${delivery.queued ? "queued" : "dispatched"}, not completed.`
      : `Created ${resource}, but the task did not start. Inspect before retrying.`,
    data: deliveryResult(resource, delivery),
  };
}

async function handleSendMessage(
  args: Record<string, unknown>,
  context: ToolCallContext
): Promise<ToolCallResult> {
  const cardId = args.cardId as string;
  const message = args.message as string;
  if (!cardId || !message) return { success: false, message: "cardId and message are required" };

  const card = context.cards.find((c) => c.id === cardId);
  if (!card) return { success: false, message: `Card ${cardId} not found` };

  if (context.signal?.aborted) return abortedResult();
  // Use the card ID as session URI (standard mapping)
  const delivery = await (context.services?.injectMessage ?? injectMessage)(context.hostUrl, cardId, message, {
    signal: context.signal,
    beforeDispatch: (identity) => recordCoordinatorDelivery(getDb(), context.idempotencyKey,
      deliveryIdentity(cardId, identity)),
  });
  return {
    success: delivery.success,
    message: delivery.success
      ? `${delivery.queued ? "Queued" : "Dispatched"} instruction to ${card.title}; awaiting its result.`
      : `Message delivery to ${card.title} is uncertain. Inspect before retrying.`,
    data: deliveryResult(cardId, delivery),
  };
}

function deliveryIdentity(resource: string, delivery: { queued?: boolean; chatUri?: string; turnId?: string }) {
  return {
    resource, chatUri: delivery.chatUri, queued: delivery.queued,
    turnId: delivery.queued ? undefined : delivery.turnId,
    pendingMessageId: delivery.queued ? delivery.turnId : undefined,
  };
}

function deliveryResult(resource: string, delivery: { success: boolean; queued?: boolean; chatUri?: string; turnId?: string }) {
  return { ...deliveryIdentity(resource, delivery),
    disposition: delivery.success ? delivery.queued ? "queued" : "dispatched" : "uncertain" };
}

async function handleAnswerInput(
  args: Record<string, unknown>,
  context: ToolCallContext
): Promise<ToolCallResult> {
  const cardId = args.cardId as string;
  const answer = args.answer as string;
  if (!cardId || !answer) return { success: false, message: "cardId and answer are required" };

  const card = context.cards.find((c) => c.id === cardId);
  if (!card) return { success: false, message: `Card ${cardId} not found` };
  if (!card.pendingInput) return { success: false, message: `Card ${card.title} has no pending input` };
  if (context.signal?.aborted) return abortedResult();
  const result = await submitAuthorizedAnswer(context.hostUrl, card, answer);
  return { success: result.answered, message: result.answered
    ? `Answered input for ${card.title}: ${result.answer}` : result.reason ?? "Input was not answered." };
}

async function handleTriggerReview(
  args: Record<string, unknown>,
  context: ToolCallContext
): Promise<ToolHandlerOutcome> {
  const cardId = args.cardId as string;
  const skillId = args.skillId as string;
  if (!cardId || !skillId) {
    return {
      result: { success: false, message: "cardId and skillId are required" },
      disposition: "terminal",
    };
  }

  const card = context.cards.find((c) => c.id === cardId);
  if (!card) {
    return {
      result: { success: false, message: `Card ${cardId} not found` },
      disposition: "terminal",
    };
  }

  const transition = resolveNextToolTransition(
    card.pendingInput?.planReview ? "plan" : getPersistedCardPhase(cardId) ?? card.phase,
  );
  if (!transition.ok) {
    return {
      result: {
        success: false,
        message: `Cannot trigger review for ${card.title}: ${transition.reason}.`,
      },
      disposition: "terminal",
    };
  }

  if (context.signal?.aborted) {
    return { result: abortedResult(), disposition: "retryable" };
  }
  const riskLevel = getRiskForAutomation(cardId, context.hostUrl);
  const config = loadConfig(card.workingDirectory);
  if (!config.skills[skillId]) {
    return {
      result: {
        success: false,
        message: `Skill ${skillId} not found in config`,
      },
      disposition: "terminal",
    };
  }
  const skill = getApplicableSkills(
    transition.value,
    riskLevel,
    config,
  ).find((candidate) => candidate.id === skillId);
  if (!skill) {
    return {
      result: {
        success: false,
        message:
          `Skill ${skillId} is not configured for ${transition.value} ` +
          `at ${riskLevel} risk`,
      },
      disposition: "terminal",
    };
  }
  const revision = resolveAuthoritativeGateRevision(
    getDb(),
    cardId,
    transition.fromPhase,
    context.hostUrl,
  );
  if (!revision.ok) {
    return {
      result: {
        success: false,
        message: `Cannot trigger review for ${card.title}: ${revision.reason}.`,
      },
      disposition: "retryable",
    };
  }

  const { success, reviewRunId, disposition } = await (
    context.services?.startReview ?? startReview
  )(
    context.hostUrl,
    cardId,
    cardId,
    coordinatorReviewPolicy(getEffectiveCoordinatorMode(context.hostUrl, cardId)).allowEdits ? skill : { ...skill, autoFix: false },
    transition.value,
    riskLevel,
    revision.changesetRef,
    { signal: context.signal, independent: true },
  );

  return {
    result: success
      ? {
          success: true,
          message:
            `Triggered ${skillId} review for ${card.title} (run #${reviewRunId})`,
        }
      : {
          success: false,
          message: disposition === "needs-human"
            ? `Review dispatch for ${card.title} is ambiguous; human review is required`
            : `Failed to trigger ${skillId} review for ${card.title}`,
        },
    disposition,
  };
}

async function handleTriggerGate(
  args: Record<string, unknown>,
  context: ToolCallContext
): Promise<ToolHandlerOutcome> {
  const cardId = args.cardId as string;
  const gateType = args.gateType as string;
  const gateName = args.gateName as string | undefined;
  if (!cardId || !gateType) {
    return {
      result: {
        success: false,
        message: "cardId and gateType are required",
      },
      disposition: "terminal",
    };
  }

  const card = context.cards.find((c) => c.id === cardId);
  if (!card) {
    return {
      result: { success: false, message: `Card ${cardId} not found` },
      disposition: "terminal",
    };
  }

  const transition = resolveNextToolTransition(
    getPersistedCardPhase(cardId) ?? card.phase,
  );
  if (!transition.ok) {
    return {
      result: {
        success: false,
        message: `Cannot trigger ${gateType} for ${card.title}: ${transition.reason}.`,
      },
      disposition: "terminal",
    };
  }

  let gateRunId: number | undefined;
  try {
    if (context.signal?.aborted) {
      return { result: abortedResult(), disposition: "retryable" };
    }
    const configuredGate = resolveConfiguredGate({
      fromPhase: transition.fromPhase,
      toPhase: transition.toPhase,
      gateType: gateType as GateType,
      gateName,
      projectPath: card.workingDirectory,
      riskLevel: getRiskForAutomation(cardId),
    });
    if (!configuredGate.ok) {
      return {
        result: {
          success: false,
          message: `Cannot trigger gate for ${card.title}: ${configuredGate.reason}.`,
        },
        disposition: "terminal",
      };
    }
    const gate = configuredGate.gate;
    if (!gate.command) {
      return {
        result: {
          success: false,
          message:
            `Cannot trigger gate for ${card.title}: no command is configured for ` +
            `${gate.gateName ?? gate.gateType}.`,
        },
        disposition: "terminal",
      };
    }
    const revision = resolveAuthoritativeGateRevision(
      getDb(),
      cardId,
      transition.fromPhase,
      context.hostUrl,
    );
    if (!revision.ok) {
      return {
        result: {
          success: false,
          message: `Cannot trigger ${gateType} for ${card.title}: ${revision.reason}.`,
        },
        disposition: "retryable",
      };
    }
    const duplicate = getGateRunsForCard(cardId).find((run) =>
      run.status === "running" && run.gateType === gate.gateType &&
      run.gateName === (gate.gateName ?? null) && run.changesetRef === revision.changesetRef);
    if (duplicate) return { result: { success: true, message: "This check is already running.", data: { gateRunId: duplicate.id } }, disposition: "terminal" };
    assertOperationCurrent("verify");
    gateRunId = startGateRun({
      cardId,
      fromPhase: transition.fromPhase,
      toPhase: transition.toPhase,
      gateType: gate.gateType,
      gateName: gate.gateName,
      changesetRef: revision.changesetRef,
      signal: context.signal,
    });

    if (!card.workingDirectory) {
      completeGateRun(gateRunId, "failed", "No local working directory is available.");
      return { result: { success: false, message: "No local working directory is available." }, disposition: "terminal" };
    }
    const status = await runOperationEffect("verify", () => new Promise<"passed" | "failed">((resolve) => {
      (context.services?.executeGateCommand ?? executeGateCommand)(gateRunId!, gate.command!, card.workingDirectory!, resolve, {
        signal: context.signal,
        isCurrent: () => { try { assertOperationCurrent("verify"); return true; } catch { return false; } },
      });
    }));
    return { result: { success: status === "passed", message: `${gate.gateType} ${status}.`, data: { gateRunId, status } }, disposition: "terminal" };
  } catch (error) {
    if (!isOperationAborted(error)) throw error;
    if (gateRunId !== undefined) {
      completeGateRun(
        gateRunId,
        "failed",
        "Cancelled before the gate instruction was dispatched.",
      );
    }
    return {
      result: abortedResult(),
      disposition: "retryable",
    };
  }
}

async function handleOverridePhase(
  args: Record<string, unknown>,
  context: ToolCallContext
): Promise<ToolCallResult> {
  const cardId = args.cardId as string;
  const targetPhase = args.targetPhase as Phase;
  const reason = args.reason as string;
  if (!cardId || !targetPhase || !reason) {
    return { success: false, message: "cardId, targetPhase, and reason are required" };
  }

  if (context.signal?.aborted) return abortedResult();
  const db = getDb();
  const authorization = authorizeAndRunOverride({
    db,
    store: getCtoContinuityStore(),
    args,
    sdkSessionId: context.sdkSessionId,
    toolCallId: context.toolCallId,
    mutate: () => setCardPhase(cardId, targetPhase),
  });
  return authorization.authorized
    ? {
        success: true,
        message: `Overrode ${cardId} to ${targetPhase}. Reason: ${reason}`,
      }
    : {
        success: false,
        message: `Cannot override ${cardId}: ${authorization.reason}`,
      };
}

async function handleAssessRisk(
  args: Record<string, unknown>,
  context: ToolCallContext
): Promise<ToolCallResult> {
  const cardId = args.cardId as string;
  if (!cardId) return { success: false, message: "cardId is required" };

  const card = context.cards.find((c) => c.id === cardId);
  if (!card) return { success: false, message: `Card ${cardId} not found` };

  const riskSnapshot = (
    context.services?.getAuthoritativeRiskSnapshot ??
    getAuthoritativeRiskSnapshot
  )(context.hostUrl, cardId);
  if (!riskSnapshot) {
    return {
      success: false,
      message:
        `Cannot assess ${card.title}: authoritative current card facts are unavailable.`,
    };
  }
  const result = await reassessAndPersistRisk(
    cardId,
    riskSnapshot,
    context.services?.assessRisk ?? assessRisk,
    context.services?.persistRisk ?? persistAuthoritativeRisk,
  );

  return {
    success: true,
    message: `Risk assessment for ${card.title}: ${result.level.toUpperCase()} — ${result.factors.join(", ")}`,
  };
}

type ToolTransition =
  | {
      ok: true;
      fromPhase: Phase;
      toPhase: Phase;
      value: `${Phase}->${Phase}`;
    }
  | { ok: false; reason: string };

function resolveNextToolTransition(current: unknown): ToolTransition {
  if (
    typeof current !== "string"
    || !PHASE_ORDER.includes(current as Phase)
  ) {
    return {
      ok: false,
      reason: `card has invalid SDLC phase ${JSON.stringify(current)}`,
    };
  }

  const fromPhase = current as Phase;
  const toPhase = getNextPhase(fromPhase);
  if (!toPhase) {
    return {
      ok: false,
      reason: `card is already in final SDLC phase ${fromPhase}`,
    };
  }

  return {
    ok: true,
    fromPhase,
    toPhase,
    value: `${fromPhase}->${toPhase}`,
  };
}
