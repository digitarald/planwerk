import type { SessionEvent } from "@github/copilot-sdk";

import type { OrchestratorToolResultEvent } from "./orchestrator-tools";

export type OrchestratorStreamEvent =
  | { type: "text"; content: string; delta?: string }
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

export function createSdkEventMapper(
  toolResults: ReadonlyMap<string, OrchestratorToolResultEvent>,
) {
  const messageOrder: string[] = [];
  const messages = new Map<string, string>();
  let error: OrchestratorStreamEvent | null = null;
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
      switch (event.type) {
        case "assistant.message_delta":
          if (event.agentId) return null;
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
          if (event.agentId) return null;
          ensureMessage(event.data.messageId);
          if (messages.get(event.data.messageId) === event.data.content) {
            return null;
          }
          messages.set(event.data.messageId, event.data.content);
          return { type: "text", content: renderContent() };
        case "tool.execution_start":
          if (event.agentId) return null;
          return {
            type: "tool",
            status: "started",
            name: event.data.toolName,
            toolCallId: event.data.toolCallId,
            result: { message: `Started ${event.data.toolName}` },
          };
        case "tool.execution_complete": {
          if (event.agentId) return null;
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
          if (event.agentId) return null;
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
