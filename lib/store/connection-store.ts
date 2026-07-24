import { create } from "zustand";
import { persist } from "zustand/middleware";

import type { ConnectionErrorCode } from "@/lib/ahp/connection-error";
import { isSupportedAhpEndpoint } from "@/lib/ahp/endpoint-config";

export type ConnectionStatus = "connected" | "reconnecting" | "disconnected";

export interface ConnectionErrorInfo {
  message: string;
  code: ConnectionErrorCode;
  hint?: string;
}

export interface ConnectionDiagnostics {
  logicalUrl: string;
  transport: "unix-websocket" | "websocket";
  resolvedTarget: string;
  candidateCount: number;
  compatibleCandidateCount: number;
  selectedSessionCount?: number;
  selectionReason?: string;
  protocolVersion: string;
  totalSessions: number;
  visibleSessions: number;
  filteredSessions: number;
}

interface ConnectionState {
  status: ConnectionStatus;
  hostUrl: string | null;
  error: ConnectionErrorInfo | null;
  diagnostics: ConnectionDiagnostics | null;
  connect: (url: string) => void;
  disconnect: () => void;
  setConnected: (diagnostics?: ConnectionDiagnostics) => void;
  setError: (error: ConnectionErrorInfo) => void;
}

export const useConnectionStore = create<ConnectionState>()(
  persist(
    (set) => ({
      status: "disconnected",
      hostUrl: null,
      error: null,
      diagnostics: null,
      connect: (url: string) => {
        if (!isSupportedAhpEndpoint(url)) {
          console.error("[ahp:conn]", "invalid URL:", url);
          set({
            status: "disconnected",
            error: { message: "Use VS Code local, ws://, or wss://", code: "unknown" },
          });
          return;
        }
        console.info("[ahp:conn]", "connecting →", url);
        set({ status: "reconnecting", hostUrl: url, error: null, diagnostics: null });
      },
      disconnect: () => {
        console.info("[ahp:conn]", "disconnecting");
        set({ status: "disconnected", hostUrl: null, error: null, diagnostics: null });
      },
      setConnected: (diagnostics) => {
        set((state) => {
          if (
            state.status === "connected"
            && state.error === null
            && (!diagnostics || state.diagnostics === diagnostics)
          ) return state;
          console.info("[ahp:conn]", "connected");
          return { status: "connected", error: null, diagnostics: diagnostics ?? state.diagnostics };
        });
      },
      setError: (error: ConnectionErrorInfo) => {
        console.error("[ahp:conn]", `error [${error.code}]:`, error.message);
        set({ status: "disconnected", error, diagnostics: null });
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
