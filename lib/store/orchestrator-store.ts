import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

export type FeedItemType =
  | "intervention"
  | "alert"
  | "transition"
  | "suggestion"
  | "triage"
  | "user"
  | "response";

export interface FeedItem {
  id: string;
  type: FeedItemType;
  message: string;
  timestamp: number;
  cardId?: string;
  cardTitle?: string;
}

interface OrchestratorState {
  feedItems: FeedItem[];
  isProcessing: boolean;
  hasConnectedOnce: boolean;
  addFeedItem: (item: Omit<FeedItem, "id" | "timestamp">) => void;
  /** Coalesce repeated transition messages (e.g. "Connected") into one item */
  upsertTransition: (message: string) => void;
  sendMessage: (message: string) => Promise<void>;
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

      sendMessage: async (message: string) => {
        const { addFeedItem } = get();

        addFeedItem({ type: "user", message });
        set({ isProcessing: true });

        try {
          const response = await fetch("/api/orchestrator/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ message }),
          });

          const data = await response.json();
          addFeedItem({ type: "response", message: data.response });
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
        feedItems: state.feedItems.slice(0, 50),
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
