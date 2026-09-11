import type { KanbanCard } from "@/lib/types";
import { buildBoardContext, buildCardDetail, getGateSummary } from "./board-context";

export {
  ORCHESTRATOR_TOOLS,
  createOrchestratorSdkTools,
  createToolAuditKey,
  validateToolArguments,
} from "./orchestrator-tools";
export type {
  OrchestratorToolName,
  ToolCallResult,
} from "./orchestrator-tools";

/**
 * System prompt for the orchestrator CTO agent.
 */
export function buildSystemPrompt(
  cards: KanbanCard[],
  selectedCard?: KanbanCard
): string {
  const boardContext = buildBoardContext(cards);
  const gateSummary = getGateSummary();
  const cardDetail = selectedCard ? buildCardDetail(selectedCard) : "";

  return `You are the CTO agent for Planwerk — an autonomous SDLC orchestrator managing AI agent sessions through a kanban pipeline (Define → Plan → Build → Review → Ship).

Your job is to help the developer manage their agent sessions efficiently. You can observe the board, steer sessions, trigger reviews and gates, and make decisions about workflow.

${boardContext}

${gateSummary ? `## Gates\n${gateSummary}` : ""}

${cardDetail}

## Guidelines
- Be concise and actionable — no filler
- When you take actions, explain what you did and why in one sentence
- Default to the least-disruptive action
- High-risk cards need human confirmation for overrides — do NOT auto-override high-risk gates
- If the user asks about a specific card, use the selected card context above
- When suggesting priorities, consider risk level and staleness
- For "what should I do next" questions, suggest based on: blocked items first, then stale items, then highest-risk items`;
}
