import "server-only";

import { injectMessage, answerInput } from "@/lib/ahp/session-messenger";
import { startReview } from "./review-executor";
import { loadConfig } from "./skill-config";
import { startGateRun, setCardPhase } from "./gate-engine";
import { assessRisk } from "./risk-assessor";
import { buildAnswer } from "@/lib/ahp/answer-value";
import type { OrchestratorToolName, ToolCallResult } from "./orchestrator-agent";
import type { KanbanCard, Phase, RiskLevel } from "@/lib/types";
import { getCardRisk } from "./risk-store";

interface ToolCallContext {
  hostUrl: string;
  cards: KanbanCard[];
}

/**
 * Execute an orchestrator tool call and return the result.
 */
export async function executeToolCall(
  toolName: OrchestratorToolName,
  args: Record<string, unknown>,
  context: ToolCallContext
): Promise<ToolCallResult> {
  try {
    switch (toolName) {
      case "create_session":
        return await handleCreateSession(args);
      case "send_message":
        return await handleSendMessage(args, context);
      case "answer_input":
        return await handleAnswerInput(args, context);
      case "trigger_review":
        return await handleTriggerReview(args, context);
      case "trigger_gate":
        return await handleTriggerGate(args, context);
      case "override_phase":
        return await handleOverridePhase(args, context);
      case "assess_risk":
        return await handleAssessRisk(args, context);
      default:
        return { success: false, message: `Unknown tool: ${toolName}` };
    }
  } catch (err) {
    return {
      success: false,
      message: `Tool execution failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
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

  // Use the card ID as session URI (standard mapping)
  const { success } = await injectMessage(context.hostUrl, cardId, message);
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

  // Dispatch by the pending input's requestId — NOT the question id — keyed
  // per-question in the answers record (see ChatInputCompletedAction shape).
  const { success, stale } = await answerInput(
    context.hostUrl,
    cardId,
    card.pendingInput.requestId,
    "accept",
    { [question.id]: { state: "submitted", value: built.value } },
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
): Promise<ToolCallResult> {
  const cardId = args.cardId as string;
  const skillId = args.skillId as string;
  if (!cardId || !skillId) return { success: false, message: "cardId and skillId are required" };

  const card = context.cards.find((c) => c.id === cardId);
  if (!card) return { success: false, message: `Card ${cardId} not found` };

  const config = loadConfig();
  const skill = config.skills[skillId];
  if (!skill) return { success: false, message: `Skill ${skillId} not found in config` };

  const storedRisk = getCardRisk(cardId);
  const riskLevel: RiskLevel = storedRisk?.level ?? card.risk ?? "medium";
  const transition = `${card.phase}->next`;

  const { success, reviewRunId } = await startReview(
    context.hostUrl,
    cardId,
    cardId,
    skill,
    transition,
    riskLevel
  );

  return success
    ? { success: true, message: `Triggered ${skillId} review for ${card.title} (run #${reviewRunId})` }
    : { success: false, message: `Failed to trigger ${skillId} review for ${card.title}` };
}

async function handleTriggerGate(
  args: Record<string, unknown>,
  context: ToolCallContext
): Promise<ToolCallResult> {
  const cardId = args.cardId as string;
  const gateType = args.gateType as string;
  if (!cardId || !gateType) return { success: false, message: "cardId and gateType are required" };

  const card = context.cards.find((c) => c.id === cardId);
  if (!card) return { success: false, message: `Card ${cardId} not found` };

  const nextPhase = getNextPhaseForCard(card.phase);
  if (!nextPhase) return { success: false, message: `No next phase after ${card.phase}` };

  const gateRunId = startGateRun(
    cardId,
    card.phase,
    nextPhase,
    gateType as "lint" | "typecheck" | "test"
  );

  // Gate execution happens async (via the AHP session or locally)
  // Nudge the agent to run the gate command
  const commands: Record<string, string> = {
    lint: "npm run lint",
    typecheck: "npm run typecheck",
    test: "npm test",
  };
  const cmd = commands[gateType] ?? gateType;
  await injectMessage(
    context.hostUrl,
    cardId,
    `Run this command and fix any issues: ${cmd}`
  );

  return {
    success: true,
    message: `Triggered ${gateType} gate for ${card.title} (run #${gateRunId}). Agent instructed to run ${cmd}.`,
  };
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

  const card = context.cards.find((c) => c.id === cardId);
  if (!card) return { success: false, message: `Card ${cardId} not found` };

  // Block override for high-risk cards without explicit human confirmation
  const storedRisk = getCardRisk(cardId);
  const riskLevel = storedRisk?.level ?? card.risk ?? "medium";
  if (riskLevel === "high") {
    return {
      success: false,
      message: `Cannot override high-risk card ${card.title} without explicit human approval. Ask the user to confirm.`,
    };
  }

  setCardPhase(cardId, targetPhase);
  return {
    success: true,
    message: `Overrode ${card.title} to ${targetPhase}. Reason: ${reason}`,
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

  const result = await assessRisk({
    title: card.title,
    activity: card.activity,
    filesChanged: card.filesChanged,
    additions: card.additions,
    deletions: card.deletions,
  });

  return {
    success: true,
    message: `Risk assessment for ${card.title}: ${result.level.toUpperCase()} — ${result.factors.join(", ")}`,
  };
}

function getNextPhaseForCard(current: Phase): Phase | null {
  const order: Phase[] = ["define", "plan", "build", "review", "ship"];
  const idx = order.indexOf(current);
  return idx >= 0 && idx < order.length - 1 ? order[idx + 1] : null;
}
