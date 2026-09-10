import "server-only";

import { CopilotClient } from "@github/copilot-sdk";

import { answerInput } from "@/lib/ahp/session-messenger";
import { buildAnswer } from "@/lib/ahp/answer-value";
import { canAutoAnswer } from "./skill-config";
import { disposeOneShotSession } from "./copilot-session";
import { getCardRisk } from "./risk-store";
import type { KanbanCard } from "@/lib/types";
import { ORCHESTRATOR_MODEL } from "./model";

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
  if (!card.pendingInput) return false;
  // Tool confirmation, execution, and OAuth authentication are host-tool
  // safety workflows, never elicitation work for the orchestrator.
  if (card.pendingInput.kind && card.pendingInput.kind !== "elicitation") return false;

  // Conservative: only auto-answer cards with an *explicit* risk assessment.
  // The card's own `risk` field defaults to "low" before triage, so relying on
  // it would auto-answer every un-triaged card. Require a persisted verdict.
  const storedRisk = getCardRisk(card.id);
  if (!storedRisk) return false;

  // Eligible when the assessed risk is at or below the configured max risk
  // (canAutoAnswer also checks that the feature is enabled).
  return canAutoAnswer(storedRisk.level);
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
  if (input.kind && input.kind !== "elicitation") {
    return { answered: false, reason: "Pending input is not an automatable elicitation" };
  }
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
      model: ORCHESTRATOR_MODEL,
      systemMessage: { content: SYSTEM_PROMPT },
    });
    let responseCompleted = false;

    try {
      const response = await session.sendAndWait(
        { prompt: context },
        15_000
      );
      responseCompleted = true;

      const answer = response?.data?.content?.trim();
      if (!answer || answer.toLowerCase() === "skip") {
        return { answered: false, reason: "LLM declined to answer" };
      }

      // Map the free-form answer onto the question's typed answer shape.
      const built = buildAnswer(question, answer);
      if (!built) {
        return { answered: false, reason: "Could not map answer to question format" };
      }

      // Submit the answer via AHP, keyed by question ID, under the request ID.
      const answers = {
        [question.id]: { state: "submitted", value: built.value },
      };
      const { success, stale } = await answerInput(
        hostUrl,
        card.id,
        input.requestId,
        "accept",
        answers,
      );

      if (success) {
        return { answered: true, answer: built.display };
      }
      return {
        answered: false,
        reason: stale
          ? "Input request no longer present (stale)"
          : "Failed to submit answer to AHP",
      };
    } finally {
      await disposeOneShotSession(
        client,
        session,
        !responseCompleted,
        "[auto-answerer]"
      );
    }
  } catch (err) {
    return {
      answered: false,
      reason: `Auto-answer failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
