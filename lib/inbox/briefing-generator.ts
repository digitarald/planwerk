import "server-only";

import type { CopilotClient } from "@github/copilot-sdk";

import {
  disposeOneShotSession,
  invalidateRuntimeForCleanupFailure,
  releaseRuntimeLease,
} from "../orchestrator/copilot-session.ts";
import { selectOrchestratorModel } from "../orchestrator/model.ts";
import {
  acquireCopilotRuntimeClient,
  classifyCopilotFailure,
} from "../orchestrator/sdk-runtime.ts";
import type { CopilotRuntimeLease } from "../orchestrator/sdk-runtime-manager.ts";
import {
  briefingSynthesisSystemPrompt,
  briefingResponseSchema,
  buildBriefingSynthesisPrompt,
  normalizeSynthesizedBriefing,
  type InboxSynthesisEvidence,
  type SynthesizedInboxBriefing,
} from "./briefing-synthesis-core.ts";

export interface GeneratedInboxBriefing {
  briefing: SynthesizedInboxBriefing;
  model: string;
}

export async function generateInboxBriefing(
  evidence: InboxSynthesisEvidence,
): Promise<GeneratedInboxBriefing> {
  let client: CopilotClient | undefined;
  let runtimeLease: CopilotRuntimeLease<CopilotClient> | undefined;
  try {
    runtimeLease = await acquireCopilotRuntimeClient();
    client = runtimeLease.client;
    const selectedModel = await selectOrchestratorModel(client, {
      role: "triage",
      override: process.env.INBOX_BRIEFING_MODEL,
      overrideName: "INBOX_BRIEFING_MODEL",
    });
    const session = await client.createSession({
      model: selectedModel.model,
      reasoningEffort: selectedModel.reasoningEffort,
      systemMessage: { content: briefingSynthesisSystemPrompt() },
      availableTools: [],
      skipCustomInstructions: true,
    });
    let responseCompleted = false;
    try {
      const response = await session.sendAndWait(
        { prompt: buildBriefingSynthesisPrompt(evidence), source: "system" },
        briefingResponseSchema(evidence.kind, evidence.eventType),
        30_000,
      );
      responseCompleted = true;
      const briefing = normalizeSynthesizedBriefing(
        response,
        evidence.kind,
        evidence.eventType,
      );
      if (!briefing) {
        throw new Error("Copilot returned an invalid inbox briefing envelope.");
      }
      return { briefing, model: selectedModel.model };
    } finally {
      const cleanup = await disposeOneShotSession(
        client,
        session,
        !responseCompleted,
        "[inbox:briefing]",
      );
      await invalidateRuntimeForCleanupFailure(
        runtimeLease,
        cleanup,
        "[inbox:briefing]",
      );
    }
  } catch (error) {
    if (runtimeLease && classifyCopilotFailure(error) === "transport") {
      await runtimeLease.invalidate(error).catch((resetError) => {
        console.warn(
          "[inbox:briefing] Failed to reset Copilot SDK runtime:",
          resetError instanceof Error ? resetError.message : resetError,
        );
      });
    }
    throw error;
  } finally {
    await releaseRuntimeLease(runtimeLease, "[inbox:briefing]");
  }
}
