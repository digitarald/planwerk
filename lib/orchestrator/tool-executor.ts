import "server-only";

import { randomUUID } from "node:crypto";

import { injectMessage, answerInput } from "@/lib/ahp/session-messenger";
import { startReview } from "./review-executor";
import { getApplicableSkills, loadConfig } from "./skill-config";
import {
  completeGateRun,
  getNextPhase,
  getPersistedCardPhase,
  resolveConfiguredGate,
  startGateRun,
  setCardPhase,
  type GateType,
} from "./gate-engine";
import { assessRisk } from "./risk-assessor";
import { buildAnswer } from "@/lib/ahp/answer-value";
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
import { dispatchGateInstruction } from "./gate-tool-dispatch";
import { resolveAuthoritativeGateRevision } from "./gate-revision";

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
  cards: KanbanCard[];
  idempotencyKey: string;
  sdkSessionId: string;
  toolCallId: string;
  signal?: AbortSignal;
  services?: {
    continuityStore?: CtoContinuityStore;
    startReview?: typeof startReview;
    injectMessage?: (
      ...args: Parameters<typeof injectMessage>
    ) => Promise<{ success: boolean; queued?: boolean }>;
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

/**
 * Execute an orchestrator tool call and return the result.
 */
export async function executeToolCall(
  toolName: OrchestratorToolName,
  args: Record<string, unknown>,
  context: ToolCallContext
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
    if (toolName === "create_session" || toolName === "assess_risk") {
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
    if (isOperationAborted(error)) {
      store.abandonToolExecution(context.idempotencyKey, ownerId);
      return { ...abortedResult(), auditKey: context.idempotencyKey };
    }
    let result = {
      success: false,
      message:
        `Tool execution failed: ${error instanceof Error ? error.message : String(error)}`,
      auditKey: context.idempotencyKey,
    };
    if (toolName === "create_session" || toolName === "assess_risk") {
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
      result = await handleCreateSession(args);
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

async function handleCreateSession(args: Record<string, unknown>): Promise<ToolCallResult> {
  const title = args.title as string;
  if (!title) return { success: false, message: "title is required" };

  // Session creation happens client-side via the AHP protocol
  // The orchestrator can only suggest — actual creation needs the VS Code host
  return {
    success: true,
    message: `Suggested creating session: "${title}". The user should create this via their editor.`,
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
  const { success } = await injectMessage(context.hostUrl, cardId, message, {
    signal: context.signal,
  });
  return success
    ? { success: true, message: `Sent message to ${card.title}: "${message.slice(0, 100)}"` }
    : { success: false, message: `Failed to send message to ${card.title}` };
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
  if (card.pendingInput.kind === "toolAuthentication") {
    return {
      success: false,
      message: `${card.title} requires tool authentication in VS Code; Planwerk never handles OAuth credentials.`,
    };
  }

  // Only elicitation-kind pending input has an answerable question; tool
  // confirmations (`card.pendingInput.toolConfirmation`) are a different wire
  // shape (chat/toolCallConfirmed) not handled by this tool.
  const question = card.pendingInput.questions[0];
  if (!question) {
    return {
      success: false,
      message: `${card.title}'s pending input isn't an answerable question (likely a tool confirmation) — this tool only answers elicitations.`,
    };
  }

  const built = buildAnswer(question, answer);
  if (!built) {
    return { success: false, message: `Could not map "${answer}" onto the question format for ${card.title}` };
  }

  if (context.signal?.aborted) return abortedResult();
  // Dispatch by the pending input's requestId — NOT the question id — keyed
  // per-question in the answers record (see ChatInputCompletedAction shape).
  const { success, stale } = await answerInput(
    context.hostUrl,
    cardId,
    card.pendingInput.requestId,
    "accept",
    { [question.id]: { state: "submitted", value: built.value } },
    { signal: context.signal },
  );
  return success
    ? { success: true, message: `Answered input for ${card.title}: ${built.display}` }
    : {
        success: false,
        message: stale
          ? `Input request for ${card.title} is no longer pending (stale)`
          : `Failed to answer input for ${card.title}`,
      };
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
    skill,
    transition.value,
    riskLevel,
    revision.changesetRef,
    { signal: context.signal },
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
    gateRunId = startGateRun({
      cardId,
      fromPhase: transition.fromPhase,
      toPhase: transition.toPhase,
      gateType: gate.gateType,
      gateName: gate.gateName,
      changesetRef: revision.changesetRef,
      signal: context.signal,
    });

    return await dispatchGateInstruction({
      cardTitle: card.title,
      gateType: gate.gateName ?? gate.gateType,
      gateRunId,
      command: gate.command,
      inject: () =>
        (context.services?.injectMessage ?? injectMessage)(
          context.hostUrl,
          cardId,
          `Run this command and fix any issues: ${gate.command}`,
          { signal: context.signal },
        ),
      failGate: (output) => completeGateRun(gateRunId!, "failed", output),
    });
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
