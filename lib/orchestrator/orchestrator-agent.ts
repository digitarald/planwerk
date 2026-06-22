import "server-only";

import type { KanbanCard } from "@/lib/types";
import { buildBoardContext, buildCardDetail, getGateSummary } from "./board-context";

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

/**
 * Tool definitions for the orchestrator's function calling.
 */
export const ORCHESTRATOR_TOOLS = [
  {
    type: "function" as const,
    function: {
      name: "create_session",
      description: "Create a new agent session for a task. Use when user wants to start new work.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "Task title" },
          workingDirectory: { type: "string", description: "Optional working directory path" },
        },
        required: ["title"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "send_message",
      description: "Send a text instruction to a running agent session. Use to steer, nudge, or give context to an agent.",
      parameters: {
        type: "object",
        properties: {
          cardId: { type: "string", description: "Card ID to message" },
          message: { type: "string", description: "Message to send to the agent" },
        },
        required: ["cardId", "message"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "answer_input",
      description: "Answer a pending input question for a session that's waiting for user input.",
      parameters: {
        type: "object",
        properties: {
          cardId: { type: "string", description: "Card ID with pending input" },
          answer: { type: "string", description: "The answer to provide" },
        },
        required: ["cardId", "answer"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "trigger_review",
      description: "Inject a review skill into a session. Use to start code review, plan review, or security review.",
      parameters: {
        type: "object",
        properties: {
          cardId: { type: "string", description: "Card ID to review" },
          skillId: {
            type: "string",
            enum: ["plan-review", "code-review", "security-review", "architecture-review"],
            description: "Review skill to trigger",
          },
        },
        required: ["cardId", "skillId"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "trigger_gate",
      description: "Run a deterministic gate check (lint, typecheck, or test) on a card.",
      parameters: {
        type: "object",
        properties: {
          cardId: { type: "string", description: "Card ID to check" },
          gateType: {
            type: "string",
            enum: ["lint", "typecheck", "test"],
            description: "Gate type to run",
          },
        },
        required: ["cardId", "gateType"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "override_phase",
      description: "Force-advance a card past its current gates. Use sparingly — creates audit trail. Refuse for high-risk cards without explicit human confirmation.",
      parameters: {
        type: "object",
        properties: {
          cardId: { type: "string", description: "Card ID to advance" },
          targetPhase: {
            type: "string",
            enum: ["plan", "build", "review", "ship"],
            description: "Phase to move the card to",
          },
          reason: { type: "string", description: "Why this override is justified" },
        },
        required: ["cardId", "targetPhase", "reason"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "assess_risk",
      description: "Re-run risk assessment on a card. Use when the card's scope has changed significantly.",
      parameters: {
        type: "object",
        properties: {
          cardId: { type: "string", description: "Card ID to assess" },
        },
        required: ["cardId"],
      },
    },
  },
] as const;

export type OrchestratorToolName = (typeof ORCHESTRATOR_TOOLS)[number]["function"]["name"];

export interface ToolCallResult {
  success: boolean;
  message: string;
}
