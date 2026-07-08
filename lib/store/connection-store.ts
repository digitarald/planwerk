import { create } from "zustand";
import { persist } from "zustand/middleware";

import type { ConnectionErrorCode } from "@/lib/ahp/connection-error";

export type ConnectionStatus = "connected" | "reconnecting" | "disconnected";

export interface ConnectionErrorInfo {
  message: string;
  code: ConnectionErrorCode;
  hint?: string;
}

interface ConnectionState {
  status: ConnectionStatus;
  hostUrl: string | null;
  error: ConnectionErrorInfo | null;
  connect: (url: string) => void;
  disconnect: () => void;
  setConnected: () => void;
  setError: (error: ConnectionErrorInfo) => void;
}

export const useConnectionStore = create<ConnectionState>()(
  persist(
    (set) => ({
      status: "disconnected",
      hostUrl: null,
      error: null,
      connect: (url: string) => {
        try {
          const parsed = new URL(url);
          if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
            set({ status: "disconnected", error: { message: "URL must use ws:// or wss:// protocol", code: "unknown" } });
            return;
          }
        } catch {
          console.error("[ahp:conn]", "invalid URL:", url);
          set({ status: "disconnected", error: { message: "Invalid connection URL", code: "unknown" } });
          return;
        }
        console.info("[ahp:conn]", "connecting →", url);
        set({ status: "reconnecting", hostUrl: url, error: null });
      },
      disconnect: () => {
        console.info("[ahp:conn]", "disconnecting");
        set({ status: "disconnected", hostUrl: null, error: null });
      },
      setConnected: () => {
        set((state) => {
          if (state.status === "connected" && state.error === null) return state;
          console.info("[ahp:conn]", "connected");
          return { status: "connected", error: null };
        });
      },
      setError: (error: ConnectionErrorInfo) => {
        console.error("[ahp:conn]", `error [${error.code}]:`, error.message);
        set({ status: "disconnected", error });
      },
    }),
    {
      name: "planwerk-connection",
      version: 1,
      migrate: () => ({ hostUrl: null }),
      partialize: (state) => ({
        hostUrl: state.hostUrl,
      }),
      onRehydrateStorage: () => (state) => {
        if (!state) return;
        if (state.hostUrl) {
          console.info("[ahp:conn]", "restoring session →", state.hostUrl);
          state.connect(state.hostUrl);
        }
      },
    },
  ),
);
