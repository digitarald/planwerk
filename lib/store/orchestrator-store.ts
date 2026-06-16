import { create } from "zustand";

export type FeedItemType =
  | "intervention"
  | "alert"
  | "transition"
  | "suggestion"
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

export const useOrchestratorStore = create<OrchestratorState>((set, get) => ({
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
}));
