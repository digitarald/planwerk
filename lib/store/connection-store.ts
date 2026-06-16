import { create } from "zustand";
import { persist } from "zustand/middleware";

import type { ConnectionErrorCode } from "@/lib/ahp/connection-error";

export type ConnectionStatus = "connected" | "reconnecting" | "disconnected";
export type ConnectionMode = "mock" | "remote";

export interface ConnectionErrorInfo {
  message: string;
  code: ConnectionErrorCode;
  hint?: string;
}

interface ConnectionState {
  status: ConnectionStatus;
  mode: ConnectionMode;
  hostUrl: string | null;
  error: ConnectionErrorInfo | null;
  connect: (url: string) => void;
  disconnect: () => void;
  setConnected: () => void;
  setError: (error: ConnectionErrorInfo) => void;
  useMockMode: () => void;
}

export const useConnectionStore = create<ConnectionState>()(
  persist(
    (set) => ({
      status: "disconnected",
      mode: "mock",
      hostUrl: null,
      error: null,
      connect: (url: string) => {
        try {
          new URL(url);
        } catch {
          console.error("[ahp:conn]", "invalid URL:", url);
          set({ status: "disconnected", error: { message: "Invalid connection URL", code: "unknown" } });
          return;
        }
        console.info("[ahp:conn]", "connecting →", url);
        set({ status: "reconnecting", mode: "remote", hostUrl: url, error: null });
      },
      disconnect: () => {
        console.info("[ahp:conn]", "disconnecting");
        set({ status: "disconnected", mode: "mock", hostUrl: null, error: null });
      },
      setConnected: () => {
        console.info("[ahp:conn]", "connected");
        set({ status: "connected", error: null });
      },
      setError: (error: ConnectionErrorInfo) => {
        console.error("[ahp:conn]", `error [${error.code}]:`, error.message);
        set({ status: "disconnected", error });
      },
      useMockMode: () => {
        console.info("[ahp:conn]", "mock mode");
        set({ status: "connected", mode: "mock", hostUrl: "mock://localhost", error: null });
      },
    }),
    {
      name: "planwerk-connection",
      partialize: (state) => ({
        // Only persist remote connections — mock mode is ephemeral
        hostUrl: state.mode === "remote" ? state.hostUrl : null,
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
