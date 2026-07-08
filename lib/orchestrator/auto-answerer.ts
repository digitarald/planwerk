import "server-only";

import { CopilotClient } from "@github/copilot-sdk";

import { answerInput } from "@/lib/ahp/session-messenger";
import { canAutoAnswer } from "./skill-config";
import { getCardRisk } from "./risk-store";
import type { KanbanCard, PendingInputQuestion } from "@/lib/types";
import { ORCHESTRATOR_MODEL } from "./model";

/**
 * A typed AHP answer value (mirrors `ChatInputAnswerValue` from the protocol).
 * Built locally as plain literals to avoid depending on ambient SDK enums.
 */
type AnswerValue =
  | { kind: "selected"; value: string }
  | { kind: "text"; value: string }
  | { kind: "boolean"; value: boolean }
  | { kind: "number"; value: number };

function parseBoolean(s: string): boolean | null {
  const v = s.trim().toLowerCase();
  if (/^(yes|y|true|enabled?|on|ok|sure|affirmative|approve)\b/.test(v)) return true;
  if (/^(no|n|false|disabled?|off|never|decline|reject)\b/.test(v)) return false;
  return null;
}

/**
 * Map a free-form LLM answer onto the typed, question-specific answer value the
 * AHP host expects. Returns the value plus a human-readable label for the feed,
 * or `null` when the answer can't be confidently mapped (so the caller escalates
 * instead of submitting a malformed answer).
 */
function buildAnswer(
  question: PendingInputQuestion,
  llmAnswer: string,
): { value: AnswerValue; display: string } | null {
  switch (question.kind) {
    case "single-select": {
      const options = question.options ?? [];
      const lower = llmAnswer.toLowerCase();
      const matched =
        options.find((o) => o.label.toLowerCase() === lower || o.id.toLowerCase() === lower) ??
        options.find(
          (o) =>
            o.label.toLowerCase().includes(lower) || lower.includes(o.label.toLowerCase()),
        ) ??
        options.find((o) => o.recommended);
      if (!matched) return null;
      return { value: { kind: "selected", value: matched.id }, display: matched.label };
    }
    case "boolean": {
      const b = parseBoolean(llmAnswer);
      if (b === null) return null;
      return { value: { kind: "boolean", value: b }, display: b ? "Yes" : "No" };
    }
    case "number": {
      const n = Number(llmAnswer.replace(/[^0-9.+-]/g, ""));
      if (!Number.isFinite(n)) return null;
      return { value: { kind: "number", value: n }, display: String(n) };
    }
    case "text": {
      return { value: { kind: "text", value: llmAnswer }, display: llmAnswer };
    }
    default:
      // multi-select (or unknown) — let a human handle it.
      return null;
  }
}

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

    try {
      const response = await session.sendAndWait(
        { prompt: context },
        15_000
      );

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
      await session.disconnect().catch(() => {});
    }
  } catch (err) {
    return {
      answered: false,
      reason: `Auto-answer failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
