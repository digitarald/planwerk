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
}

interface OrchestratorState {
  feedItems: FeedItem[];
  isProcessing: boolean;
  addFeedItem: (item: Omit<FeedItem, "id" | "timestamp">) => void;
  sendMessage: (message: string) => Promise<void>;
  clearFeed: () => void;
}

let feedCounter = 0;

export const useOrchestratorStore = create<OrchestratorState>()(
  persist(
    (set, get) => ({
      feedItems: [],
      isProcessing: false,

      addFeedItem: (item) => {
        feedCounter++;
        set((state) => ({
          feedItems: [
            { ...item, id: `feed-${feedCounter}`, timestamp: Date.now() },
            ...state.feedItems,
          ],
        }));
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
