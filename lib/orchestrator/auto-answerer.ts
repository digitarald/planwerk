import "server-only";

import { CopilotClient } from "@github/copilot-sdk";

import { answerInput } from "@/lib/ahp/session-messenger";
import { loadConfig } from "./skill-config";
import { getCardRisk } from "./risk-store";
import type { KanbanCard, RiskLevel } from "@/lib/types";

const RISK_ORDER: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2 };

// Reuse the singleton pattern from risk-assessor
let clientInstance: CopilotClient | null = null;
let clientStarting: Promise<CopilotClient> | null = null;

async function getClient(): Promise<CopilotClient> {
  if (clientInstance) return clientInstance;
  if (clientStarting) return clientStarting;

  clientStarting = (async () => {
    try {
      const client = new CopilotClient();
      await client.start();
      clientInstance = client;
      return client;
    } finally {
      clientStarting = null;
    }
  })();

  return clientStarting;
}

const SYSTEM_PROMPT = `You are helping an AI agent session that is waiting for user input. Based on the context provided, generate a reasonable answer to the pending question.

Rules:
- Be concise — just the answer, no preamble
- If the question is a yes/no or selection, just state the choice
- If the question asks for a path or name, provide a reasonable default
- If you're not confident, say "skip" and the question will be escalated to a human
- Never make security-sensitive decisions (credentials, permissions, deployments)`;

export interface AutoAnswerResult {
  answered: boolean;
  answer?: string;
  reason?: string;
}

/**
 * Determine if a card's pending input should be auto-answered.
 */
export function shouldAutoAnswer(card: KanbanCard): boolean {
  const config = loadConfig();
  if (!config.orchestrator.autoAnswerInput.enabled) return false;
  if (!card.pendingInput) return false;

  const storedRisk = getCardRisk(card.id);
  const cardRisk = storedRisk?.level ?? card.risk ?? "medium";
  const maxRisk = config.orchestrator.autoAnswerInput.maxRisk;

  return RISK_ORDER[cardRisk] < RISK_ORDER[maxRisk];
}

/**
 * Auto-answer a pending input question using the Copilot SDK.
 */
export async function autoAnswer(
  hostUrl: string,
  card: KanbanCard
): Promise<AutoAnswerResult> {
  if (!card.pendingInput) {
    return { answered: false, reason: "No pending input" };
  }

  const input = card.pendingInput;
  const question = input.questions[0];
  if (!question) {
    return { answered: false, reason: "No questions in pending input" };
  }

  // Build context for the LLM
  const context = [
    `Task: ${card.title}`,
    `Phase: ${card.phase}`,
    `Activity: ${card.activity}`,
    input.message ? `Context: ${input.message}` : null,
    `Question: ${question.title}`,
    question.message ? `Detail: ${question.message}` : null,
    question.kind === "single-select" && question.options
      ? `Options: ${question.options.map((o) => `${o.label}${o.recommended ? " (recommended)" : ""}`).join(", ")}`
      : null,
    question.kind === "boolean" ? `Type: Yes/No question` : null,
  ]
    .filter(Boolean)
    .join("\n");

  try {
    const client = await getClient();
    const session = await client.createSession({
      model: "gpt-4.1",
      systemMessage: { content: SYSTEM_PROMPT },
    });

    try {
      const response = await session.sendAndWait(
        { prompt: context },
        15_000
      );

      const answer = response?.data?.content?.trim();
      if (!answer || answer.toLowerCase() === "skip") {
        return { answered: false, reason: "LLM declined to answer" };
      }

      // For single-select, match the answer to an option
      let finalAnswer = answer;
      if (question.kind === "single-select" && question.options) {
        const matchedOption = question.options.find(
          (o) =>
            o.label.toLowerCase().includes(answer.toLowerCase()) ||
            answer.toLowerCase().includes(o.label.toLowerCase())
        );
        if (matchedOption) {
          finalAnswer = matchedOption.id;
        } else if (question.options.some((o) => o.recommended)) {
          // Fall back to recommended option
          finalAnswer = question.options.find((o) => o.recommended)!.id;
        }
      }

      // Submit the answer via AHP
      const requestId = question.id ?? "unknown";
      const { success } = await answerInput(
        hostUrl,
        card.id,
        requestId,
        "accept",
        { answer: finalAnswer }
      );

      if (success) {
        return { answered: true, answer: finalAnswer };
      }
      return { answered: false, reason: "Failed to submit answer to AHP" };
    } finally {
      await session.disconnect().catch(() => {});
    }
  } catch (err) {
    return {
      answered: false,
      reason: `Auto-answer failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
