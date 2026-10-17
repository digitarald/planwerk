import "server-only";

import type { CopilotClient } from "@github/copilot-sdk";

import { withAHPClient } from "@/lib/ahp/client-operation";
import { mapSessionInputNeeded } from "@/lib/ahp/map-session";
import { answerInputWithClient } from "@/lib/ahp/session-messenger";
import { readActiveSessionState } from "@/lib/ahp/snapshot";
import { buildAnswer } from "@/lib/ahp/answer-value";
import { canAutoAnswer } from "./skill-config";
import {
  disposeOneShotSession,
  invalidateRuntimeForCleanupFailure,
  releaseRuntimeLease,
} from "./copilot-session";
import {
  getAuthoritativeCardRisk,
  getAuthoritativeRiskSnapshot,
} from "./risk-store";
import { authorizePendingElicitation } from "./risk-facts";
import { riskAutomationPolicy } from "./risk-authority";
import type { KanbanCard } from "@/lib/types";
import { selectOrchestratorModel } from "./model";
import {
  acquireCopilotRuntimeClient,
  classifyCopilotFailure,
} from "./sdk-runtime";
import type { CopilotRuntimeLease } from "./sdk-runtime-manager";
import { assertOperationCurrent, getOperationSignal } from "./operation-context";
import { awaitAbortable } from "@/lib/abort";

const SYSTEM_PROMPT = `You are helping an AI agent session that is waiting for user input. Based on the context provided, generate a reasonable answer to the pending question.

Rules:
- Be concise — just the answer, no preamble
- Choose only one of the supplied options, or answer a benign yes/no question
- Never propose or execute commands, tools, filesystem changes, or network actions
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
export function shouldAutoAnswer(
  hostUrl: string,
  card: KanbanCard,
): boolean {
  if (!card.pendingInput) return false;
  const authorization = authorizePendingElicitation(card.pendingInput);
  if (!authorization.allowed || !authorization.digest) return false;
  const facts = getAuthoritativeRiskSnapshot(hostUrl, card.id);
  if (facts?.elicitationDigest !== authorization.digest) return false;

  // Conservative: only auto-answer cards with an *explicit* risk assessment.
  // The card's own `risk` field defaults to "low" before triage, so relying on
  // it would auto-answer every un-triaged card. Require a persisted verdict.
  const risk = getAuthoritativeCardRisk(card.id, hostUrl);
  const policy = riskAutomationPolicy(risk);
  if (!policy.current) return false;

  // Eligible when the assessed risk is at or below the configured max risk
  // (canAutoAnswer also checks that the feature is enabled).
  return canAutoAnswer(policy.level);
}

/**
 * Auto-answer a pending input question using the Copilot SDK.
 */
export async function autoAnswer(
  hostUrl: string,
  card: KanbanCard
): Promise<AutoAnswerResult> {
  assertOperationCurrent("interact");
  if (!card.pendingInput) {
    return { answered: false, reason: "No pending input" };
  }
  const input = card.pendingInput;
  const inputAuthorization = authorizePendingElicitation(input);
  if (!inputAuthorization.allowed || !inputAuthorization.digest) {
    return {
      answered: false,
      reason: inputAuthorization.reason ?? "Pending input is not authorized for auto-answer",
    };
  }

  const initialFacts = getAuthoritativeRiskSnapshot(hostUrl, card.id);
  if (initialFacts?.elicitationDigest !== inputAuthorization.digest) {
    return {
      answered: false,
      reason: "Pending input does not match server-observed authorization facts",
    };
  }

  const initialRisk = getAuthoritativeCardRisk(card.id, hostUrl);
  const initialPolicy = riskAutomationPolicy(initialRisk);
  if (
    !initialPolicy.current
    || initialRisk.status !== "current"
    || initialRisk.currentDigest !== initialFacts.digest
  ) {
    return {
      answered: false,
      reason: initialPolicy.reason ?? "Current risk assessment required",
    };
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

  let client: CopilotClient | undefined;
  let runtimeLease: CopilotRuntimeLease<CopilotClient> | undefined;
  try {
    runtimeLease = await acquireCopilotRuntimeClient();
    assertOperationCurrent("interact");
    client = runtimeLease.client;
    const selectedModel = await selectOrchestratorModel(client, {
      role: "triage",
      risk: initialPolicy.level,
    });
    assertOperationCurrent("interact");
    const session = await client.createSession({
      model: selectedModel.model,
      reasoningEffort: selectedModel.reasoningEffort,
      systemMessage: { content: SYSTEM_PROMPT },
      availableTools: [],
      skipCustomInstructions: true,
    });
    let responseCompleted = false;
    const signal = getOperationSignal();
    const abort = () => {
      void Promise.resolve().then(() => session.abort()).catch(() => {});
    };
    signal?.addEventListener("abort", abort, { once: true });

    try {
      assertOperationCurrent("interact");
      const response = await awaitAbortable(
        () => session.sendAndWait(
          { prompt: context, source: "system" },
          15_000,
        ),
        signal,
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
      assertOperationCurrent("interact");
      const dispatch = await withAHPClient(hostUrl, async (ahpClient) => {
        const liveState = await readActiveSessionState(ahpClient, card.id);
        const liveInput = mapSessionInputNeeded(liveState?.inputNeeded);
        const liveAuthorization = authorizePendingElicitation(liveInput);
        if (
          !liveAuthorization.allowed
          || liveAuthorization.digest !== inputAuthorization.digest
        ) {
          return {
            success: false,
            authorizationReason:
              liveAuthorization.reason
              ?? "Pending elicitation changed while preparing the answer",
          };
        }

        // Revalidate both the exact elicitation and the risk assessment after
        // observing the live AHP request, immediately before dispatch.
        const currentFacts = getAuthoritativeRiskSnapshot(hostUrl, card.id);
        const currentRisk = getAuthoritativeCardRisk(card.id, hostUrl);
        if (
          currentFacts?.elicitationDigest !== liveAuthorization.digest
          || currentRisk.status !== "current"
          || currentRisk.currentDigest !== currentFacts.digest
          || currentRisk.assessment.riskDigest !== initialRisk.assessment.riskDigest
        ) {
          return {
            success: false,
            authorizationReason: "Risk or elicitation authorization became stale while preparing the answer",
          };
        }

        assertOperationCurrent("interact");
        return answerInputWithClient(
          ahpClient,
          card.id,
          input.requestId,
          "accept",
          answers,
          { signal: getOperationSignal() },
        );
      });

      if (dispatch.success) {
        return { answered: true, answer: built.display };
      }
      return {
        answered: false,
        reason: "authorizationReason" in dispatch
          ? dispatch.authorizationReason
          : dispatch.stale
          ? "Input request no longer present (stale)"
          : "Failed to submit answer to AHP",
      };
    } finally {
      signal?.removeEventListener("abort", abort);
      const cleanup = await disposeOneShotSession(
        client,
        session,
        !responseCompleted,
        "[auto-answerer]"
      );
      await invalidateRuntimeForCleanupFailure(
        runtimeLease,
        cleanup,
        "[auto-answerer]",
      );
    }
  } catch (err) {
    if (runtimeLease && classifyCopilotFailure(err) === "transport") {
      await runtimeLease.invalidate(err).catch((resetError) => {
      console.warn(
        "[auto-answerer] Failed to reset Copilot SDK runtime:",
        resetError instanceof Error ? resetError.message : resetError
      );
      });
    }
    return {
      answered: false,
      reason: `Auto-answer failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    await releaseRuntimeLease(runtimeLease, "[auto-answerer]");
  }
}
