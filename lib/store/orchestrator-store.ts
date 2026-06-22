import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

export type FeedItemType =
  | "intervention"
  | "alert"
  | "transition"
  | "suggestion"
  | "triage"
  | "user"
  | "response"
  | "heartbeat"
  | "tool-action";

export interface FeedItem {
  id: string;
  type: FeedItemType;
  message: string;
  timestamp: number;
  cardId?: string;
  cardTitle?: string;
  isStreaming?: boolean;
  toolName?: string;
}

interface OrchestratorState {
  feedItems: FeedItem[];
  isProcessing: boolean;
  hasConnectedOnce: boolean;
  addFeedItem: (item: Omit<FeedItem, "id" | "timestamp">) => void;
  /** Update the most recent response item (for streaming) */
  updateLastResponse: (message: string, done?: boolean) => void;
  /** Coalesce repeated transition messages (e.g. "Connected") into one item */
  upsertTransition: (message: string) => void;
  sendMessage: (message: string, hostUrl?: string, cards?: unknown[]) => Promise<void>;
  clearFeed: () => void;
}

let feedCounter = 0;

export const useOrchestratorStore = create<OrchestratorState>()(
  persist(
    (set, get) => ({
      feedItems: [],
      isProcessing: false,
      hasConnectedOnce: false,

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
          };
          return { feedItems: updated };
        });
      },

      upsertTransition: (message: string) => {
        set((state) => {
          // Find the most recent transition item to coalesce into
          const idx = state.feedItems.findIndex((f) => f.type === "transition");
          if (idx !== -1) {
            const updated = [...state.feedItems];
            updated[idx] = { ...updated[idx], message, timestamp: Date.now() };
            return { feedItems: updated, hasConnectedOnce: true };
          }
          // First transition ever — create a new one
          feedCounter++;
          return {
            hasConnectedOnce: true,
            feedItems: [
              { id: `feed-${feedCounter}`, type: "transition" as const, message, timestamp: Date.now() },
              ...state.feedItems,
            ],
          };
        });
      },

      sendMessage: async (message: string, hostUrl?: string, cards?: unknown[]) => {
        const { addFeedItem, updateLastResponse } = get();

        addFeedItem({ type: "user", message });
        set({ isProcessing: true });

        try {
          const response = await fetch("/api/orchestrator/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ message, hostUrl, cards }),
          });

          const contentType = response.headers.get("content-type") ?? "";

          if (contentType.includes("text/event-stream")) {
            // Streaming response — read SSE events
            addFeedItem({ type: "response", message: "", isStreaming: true });

            const reader = response.body?.getReader();
            if (!reader) throw new Error("No response body");

            const decoder = new TextDecoder();
            let buffer = "";

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
                    updateLastResponse(event.content);
                  } else if (event.type === "tool") {
                    addFeedItem({
                      type: "tool-action",
                      message: event.result?.message ?? `Executed ${event.name}`,
                      toolName: event.name,
                    });
                  } else if (event.type === "done") {
                    updateLastResponse(
                      get().feedItems.find((f) => f.isStreaming)?.message ?? "",
                      true
                    );
                  }
                } catch {
                  // Skip malformed events
                }
              }
            }

            // Ensure streaming state is cleaned up
            updateLastResponse(
              get().feedItems.find((f) => f.isStreaming)?.message ?? "",
              true
            );
          } else {
            // Non-streaming JSON fallback
            const data = await response.json();
            addFeedItem({ type: "response", message: data.response });
          }
        } catch {
          addFeedItem({
            type: "alert",
            message: "Failed to process message. Try again.",
          });
        } finally {
          set({ isProcessing: false });
        }
      },

      clearFeed: () => set({ feedItems: [] }),
    }),
    {
      name: "planwerk-feed",
      storage: createJSONStorage(() => sessionStorage),
      partialize: (state) => ({
        feedItems: state.feedItems
          .filter((f) => !f.isStreaming)
          .slice(0, 50),
      }),
      onRehydrateStorage: () => (state) => {
        if (!state) return;
        feedCounter = state.feedItems.reduce((max, item) => {
          const match = /^feed-(\d+)$/.exec(item.id);
          return match ? Math.max(max, Number(match[1])) : max;
        }, 0);
      },
    },
  ),
);
