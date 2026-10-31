import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { orchestratorHttpErrorMessage } from "./orchestrator-response.ts";
import type { SdkUsageSummary } from "../orchestrator/sdk-usage.ts";

export type FeedItemType =
  | "intervention"
  | "alert"
  | "transition"
  | "suggestion"
  | "triage"
  | "user"
  | "response"
  | "heartbeat"
  | "tool-action"
  | "setting"
  | "approval-required";

export interface PendingCtoApproval {
  decisionCapability: string;
  toolName: string;
  riskLevel: string;
  action: Record<string, unknown>;
  facts: Record<string, unknown>;
  expiresAtMs: number;
}

export interface FeedItem {
  id: string;
  type: FeedItemType;
  message: string;
  timestamp: number;
  cardId?: string;
  cardTitle?: string;
  projectName?: string;
  isStreaming?: boolean;
  toolName?: string;
  approval?: PendingCtoApproval;
  decisionPending?: boolean;
  submissionStatus?: "blocked";
  context?: { currentTokens?: number; tokenLimit?: number; compacting: boolean; updatedAt: string };
  usage?: SdkUsageSummary;
}

export function closeCtoApprovals(
  feedItems: FeedItem[],
  capabilities: ReadonlySet<string>,
): FeedItem[] {
  return feedItems.map((item) =>
    item.approval &&
      capabilities.has(item.approval.decisionCapability)
      ? {
          ...item,
          type: "alert",
          message: "This approval expired when the CTO turn ended.",
          approval: undefined,
          decisionPending: false,
        }
      : item
  );
}

/** Instrument-readout state for the connection/monitoring status. Kept out of
 *  the conversational feed so system status never reads as CTO dialogue. */
export interface MonitoringStatus {
  sessionCount: number;
  reconnected: boolean;
  updatedAt: number;
}

interface OrchestratorState {
  draft: string;
  setDraft: (draft: string) => void;
  feedItems: FeedItem[];
  isProcessing: boolean;
  hasConnectedOnce: boolean;
  monitoringStatus: MonitoringStatus | null;
  addFeedItem: (item: Omit<FeedItem, "id" | "timestamp">) => void;
  /** Update the most recent response item (for streaming) */
  updateLastResponse: (message: string, done?: boolean) => void;
  /** Record connection/monitoring status (rendered in the pinned status line,
   *  not the feed). */
  setMonitoringStatus: (sessionCount: number) => void;
  sendMessage: (message: string, hostUrl?: string, workspaceScope?: string[], selectedCardId?: string | null) => Promise<void>;
  decideApproval: (
    decisionCapability: string,
    decision: "approve" | "reject",
  ) => Promise<void>;
  clearFeed: () => void;
}

let feedCounter = 0;

export const useOrchestratorStore = create<OrchestratorState>()(
  persist(
    (set, get) => ({
      draft: "",
      setDraft: (draft) => set({ draft }),
      feedItems: [],
      isProcessing: false,
      hasConnectedOnce: false,
      monitoringStatus: null,

      addFeedItem: (item) => {
        feedCounter++;
        set((state) => ({
          feedItems: [
            { ...item, id: `feed-${feedCounter}`, timestamp: Date.now() },
            ...state.feedItems,
          ],
        }));
      },

      updateLastResponse: (message: string, done = false) => {
        set((state) => {
          const idx = state.feedItems.findIndex(
            (f) => f.type === "response" && f.isStreaming
          );
          if (idx === -1) return state;
          const updated = [...state.feedItems];
          updated[idx] = {
            ...updated[idx],
            message,
            isStreaming: !done,
            ...(done && updated[idx].context ? { context: { ...updated[idx].context, compacting: false } } : {}),
          };
          return { feedItems: updated };
        });
      },

      setMonitoringStatus: (sessionCount: number) => {
        set((state) => ({
          monitoringStatus: {
            sessionCount,
            reconnected: state.hasConnectedOnce,
            updatedAt: Date.now(),
          },
          hasConnectedOnce: true,
        }));
      },

      decideApproval: async (decisionCapability, decision) => {
        set((state) => ({
          feedItems: state.feedItems.map((item) =>
            item.approval?.decisionCapability === decisionCapability
              ? { ...item, decisionPending: true }
              : item
          ),
        }));
        try {
          const response = await fetch("/api/orchestrator/approvals", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ decisionCapability, decision }),
          });
          if (!response.ok) {
            let message = "This decision request is no longer active.";
            try {
              const payload = await response.json() as { error?: unknown };
              if (typeof payload.error === "string") message = payload.error;
            } catch {}
            set((state) => ({
              feedItems: state.feedItems.map((item) =>
                item.approval?.decisionCapability === decisionCapability
                  ? {
                      ...item,
                      type: "alert",
                      message,
                      approval: undefined,
                      decisionPending: false,
                    }
                  : item
              ),
            }));
            return;
          }
          set((state) => ({
            feedItems: state.feedItems.map((item) =>
              item.approval?.decisionCapability === decisionCapability
                ? {
                    ...item,
                    type: "tool-action",
                    message: decision === "approve"
                      ? "High-risk action approved once."
                      : "High-risk action rejected.",
                    approval: undefined,
                    decisionPending: false,
                  }
                : item
            ),
          }));
        } catch {
          set((state) => ({
            feedItems: state.feedItems.map((item) =>
              item.approval?.decisionCapability === decisionCapability
                ? { ...item, decisionPending: false }
                : item
            ),
          }));
        }
      },

      sendMessage: async (message: string, hostUrl?: string, workspaceScope: string[] = [], selectedCardId?: string | null) => {
        const { addFeedItem, updateLastResponse } = get();
        const streamApprovals = new Set<string>();
        let streamReader: ReadableStreamDefaultReader<Uint8Array> | undefined;

        addFeedItem({ type: "user", message });
        const submittedFeedId = get().feedItems[0]?.id;
        set({ isProcessing: true });

        try {
          const response = await fetch("/api/orchestrator/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ message, hostUrl, workspaceScope, selectedCardId }),
          });

          const contentType = response.headers.get("content-type") ?? "";
          if (!response.ok) {
            let payload: unknown;
            try {
              payload = await response.json();
            } catch {
              payload = undefined;
            }
            addFeedItem({
              type: "alert",
              message: orchestratorHttpErrorMessage(response.status, payload),
            });
            return;
          }

          if (contentType.includes("text/event-stream")) {
            // Streaming response — read SSE events
            addFeedItem({ type: "response", message: "", isStreaming: true });

            const reader = response.body?.getReader();
            if (!reader) throw new Error("No response body");
            streamReader = reader;

            const decoder = new TextDecoder();
            let buffer = "";
            let receivedText = false;
            let receivedError = false;
            const warnings = new Set<string>();

            while (true) {
              const { done, value } = await reader.read();
              if (done) break;

              buffer += decoder.decode(value, { stream: true });
              const lines = buffer.split("\n");
              buffer = lines.pop() ?? "";

              for (const line of lines) {
                if (!line.startsWith("data: ")) continue;
                const jsonStr = line.slice(6);
                try {
                  const event = JSON.parse(jsonStr);
                  if (event.type === "text") {
                    receivedText = Boolean(event.content);
                    updateLastResponse(event.content);
                  } else if (event.type === "tool") {
                    addFeedItem({
                      type: "tool-action",
                      message: event.result?.message ?? `Executed ${event.name}`,
                      toolName: event.name,
                    });
                  } else if (
                    event.type === "approval-required" &&
                    typeof event.decisionCapability === "string" &&
                    typeof event.toolName === "string" &&
                    typeof event.expiresAtMs === "number"
                  ) {
                    streamApprovals.add(event.decisionCapability);
                    const targetPhase =
                      typeof event.action?.targetPhase === "string"
                        ? ` to ${event.action.targetPhase}`
                        : "";
                    addFeedItem({
                      type: "approval-required",
                      message:
                        `Review ${event.toolName}${targetPhase} before it runs.`,
                      cardId:
                        typeof event.cardId === "string"
                          ? event.cardId
                          : undefined,
                      toolName: event.toolName,
                      approval: {
                        decisionCapability: event.decisionCapability,
                        toolName: event.toolName,
                        riskLevel:
                          typeof event.riskLevel === "string"
                            ? event.riskLevel
                            : "high",
                        action:
                          event.action && typeof event.action === "object"
                            ? event.action
                            : {},
                        facts:
                          event.facts && typeof event.facts === "object"
                            ? event.facts
                            : {},
                        expiresAtMs: event.expiresAtMs,
                      },
                    });
                  } else if (event.type === "warning" && typeof event.message === "string") {
                    if (!warnings.has(event.id)) {
                      warnings.add(event.id);
                      addFeedItem({ type: "alert", message: event.message });
                    }
                  } else if (event.type === "context" || event.type === "usage") {
                    if (typeof event.error === "string") addFeedItem({ type: "alert", message: event.error });
                    set((state) => ({
                      feedItems: state.feedItems.map((item) => item.isStreaming
                        ? { ...item, ...(event.type === "context" ? { context: {
                          currentTokens: event.currentTokens, tokenLimit: event.tokenLimit,
                          compacting: event.compacting, updatedAt: event.updatedAt,
                        } } : { usage: event.usage }) }
                        : item),
                    }));
                  } else if (event.type === "error") {
                    receivedError = true;
                    updateLastResponse(
                      `${event.message ?? "CTO stream failed"}. Please try again.`
                    );
                  } else if (event.type === "done") {
                    if (event.status === "blocked") {
                      receivedError = true;
                      if (!get().draft) set({ draft: message });
                      set((state) => ({
                        feedItems: state.feedItems.map((item) => item.isStreaming || item.id === submittedFeedId
                          ? { ...item, submissionStatus: "blocked" }
                          : item),
                      }));
                      updateLastResponse(`Not submitted: ${event.message ?? "Blocked by policy."}`, true);
                      continue;
                    }
                    updateLastResponse(
                      get().feedItems.find((f) => f.isStreaming)?.message ?? "",
                      true
                    );
                  }
                } catch (error) {
                  console.error("Invalid coordinator stream event", error);
                  throw new Error("The coordinator stream could not be read.");
                }
              }
            }

            if (!receivedText && !receivedError) {
              updateLastResponse(
                "No CTO response was received. Please try again."
              );
            }
            // Ensure streaming state is cleaned up
            updateLastResponse(
              get().feedItems.find((f) => f.isStreaming)?.message ?? "",
              true
            );
          } else {
            // Non-streaming JSON fallback
            const data = await response.json();
            if (typeof data.response === "string" && data.response.trim()) {
              addFeedItem({ type: "response", message: data.response });
            } else {
              addFeedItem({
                type: "alert",
                message: "No CTO response was received. Please try again.",
              });
            }
          }
        } catch {
          const streaming = get().feedItems.find(
            (item) => item.type === "response" && item.isStreaming
          );
          if (streaming) {
            updateLastResponse(
              `${streaming.message}${streaming.message ? "\n\n" : ""}` +
                "The CTO response was interrupted. Please try again.",
              true
            );
          } else {
            addFeedItem({
              type: "alert",
              message: "Failed to process message. Try again.",
            });
          }
        } finally {
          if (streamReader) {
            await streamReader.cancel().catch((error) => {
              console.error("Failed to cancel coordinator stream", error);
            });
            streamReader.releaseLock();
          }
          set((state) => ({
            isProcessing: false,
            feedItems: closeCtoApprovals(
              state.feedItems,
              streamApprovals,
            ),
          }));
        }
      },

      clearFeed: () => set((state) => ({
        feedItems: state.feedItems.filter(
          (item) => item.isStreaming || item.approval || item.decisionPending
        ),
      })),
    }),
    {
      name: "planwerk-feed",
      storage: createJSONStorage(() => sessionStorage),
      partialize: (state) => ({
        feedItems: state.feedItems
          .filter((f) => !f.isStreaming && !f.approval)
          .slice(0, 50),
      }),
      onRehydrateStorage: () => (state) => {
        if (!state) return;
        // Drop legacy connection/monitoring items that older builds pushed into
        // the feed — connection status now lives in the pinned status line, so
        // these would violate the conversation/instrument separation.
        const legacyMonitoring = /^(Monitoring \d+ session|Reconnected\. Monitoring \d+ session)/;
        state.feedItems = state.feedItems.filter(
          (item) => !(item.type === "transition" && legacyMonitoring.test(item.message))
        );
        feedCounter = state.feedItems.reduce((max, item) => {
          const match = /^feed-(\d+)$/.exec(item.id);
          return match ? Math.max(max, Number(match[1])) : max;
        }, 0);
      },
    },
  ),
);
