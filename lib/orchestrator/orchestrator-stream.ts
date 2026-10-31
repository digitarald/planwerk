import type { SessionEvent } from "@github/copilot-sdk";
import { createSdkUsageTracker, type SdkUsageSummary } from "./sdk-usage.ts";

import type { OrchestratorToolResultEvent } from "./orchestrator-tools";

export type OrchestratorStreamEvent =
  | { type: "text"; content: string; delta?: string }
  | { type: "warning"; id: string; message: string; warningType: string; originatingMessageId?: string }
  | { type: "context"; currentTokens?: number; tokenLimit?: number; compacting: boolean; updatedAt: string; error?: string }
  | { type: "usage"; usage: SdkUsageSummary }
  | {
      type: "tool";
      status: "started" | "completed";
      name: string;
      toolCallId: string;
      result: { success?: boolean; message: string; auditKey?: string };
    }
  | {
      type: "error";
      status: "error" | "degraded";
      message: string;
      errorType?: string;
      actionsDisabled: boolean;
    };

export function isPrimarySdkSessionTermination(event: SessionEvent): boolean {
  return !event.agentId &&
    (event.type === "session.shutdown" || event.type === "session.error");
}

export function createSdkEventMapper(
  toolResults: ReadonlyMap<string, OrchestratorToolResultEvent>,
) {
  const messageOrder: string[] = [];
  const messages = new Map<string, string>();
  let error: Extract<OrchestratorStreamEvent, { type: "error" }> | null = null;
  const seen = new Set<string>();
  let currentTokens: number | undefined;
  let tokenLimit: number | undefined;
  let compacting = false;
  const trackUsage = createSdkUsageTracker();
  const renderContent = () =>
    messageOrder
      .map((messageId) => messages.get(messageId) ?? "")
      .filter(Boolean)
      .join("\n\n");
  const ensureMessage = (messageId: string) => {
    if (messages.has(messageId)) return;
    messageOrder.push(messageId);
    messages.set(messageId, "");
  };

  return {
    map(event: SessionEvent): OrchestratorStreamEvent | null {
      if (event.id) {
        if (seen.has(event.id)) return null;
        seen.add(event.id);
      }
      const usage = trackUsage(event);
      if (usage) return { type: "usage", usage };
      if (event.agentId) return null;
      switch (event.type) {
        case "session.warning":
          return { type: "warning", id: event.id, ...event.data };
        case "session.usage_info":
          currentTokens = event.data.currentTokens;
          tokenLimit = event.data.tokenLimit;
          return { type: "context", currentTokens, tokenLimit, compacting, updatedAt: event.timestamp };
        case "session.compaction_start":
          compacting = true;
          return { type: "context", currentTokens, tokenLimit, compacting, updatedAt: event.timestamp };
        case "session.compaction_complete":
          compacting = false;
          if (event.data.success) currentTokens = event.data.postCompactionTokens ?? currentTokens;
          return { type: "context", currentTokens, tokenLimit, compacting, updatedAt: event.timestamp,
            error: event.data.success ? undefined : event.data.error ?? `Compaction ${event.data.outcome ?? "did not complete"}` };
        case "assistant.message_delta":
          ensureMessage(event.data.messageId);
          messages.set(
            event.data.messageId,
            (messages.get(event.data.messageId) ?? "") +
              event.data.deltaContent
          );
          return {
            type: "text",
            content: renderContent(),
            delta: event.data.deltaContent,
          };
        case "assistant.message":
          ensureMessage(event.data.messageId);
          if (messages.get(event.data.messageId) === event.data.content) {
            return null;
          }
          messages.set(event.data.messageId, event.data.content);
          return { type: "text", content: renderContent() };
        case "tool.execution_start":
          return {
            type: "tool",
            status: "started",
            name: event.data.toolName,
            toolCallId: event.data.toolCallId,
            result: { message: `Started ${event.data.toolName}` },
          };
        case "tool.execution_complete": {
          const recorded = toolResults.get(event.data.toolCallId);
          return {
            type: "tool",
            status: "completed",
            name: recorded?.toolName ?? event.data.toolDescription?.name ?? "tool",
            toolCallId: event.data.toolCallId,
            result: recorded?.result ?? {
              success: event.data.success,
              message:
                event.data.error?.message ??
                event.data.result?.detailedContent ??
                event.data.result?.content ??
                (event.data.success ? "Tool completed" : "Tool failed"),
            },
          };
        }
        case "session.error":
          error = {
            type: "error",
            status: "error",
            message: event.data.message,
            errorType: event.data.errorType,
            actionsDisabled: true,
          };
          return error;
        default:
          return null;
      }
    },
    get content() {
      return renderContent();
    },
    get error() {
      return error;
    },
  };
}

export function mapSdkFailure(
  error: unknown,
  status: "error" | "degraded" = "error",
): Extract<OrchestratorStreamEvent, { type: "error" }> {
  return {
    type: "error",
    status,
    message: error instanceof Error ? error.message : String(error),
    errorType: error instanceof Error ? error.name : "unknown",
    actionsDisabled: true,
  };
}
