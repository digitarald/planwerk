import { create } from "zustand";

export type ConnectionStatus = "connected" | "reconnecting" | "disconnected";
export type ConnectionMode = "mock" | "remote";

interface ConnectionState {
  status: ConnectionStatus;
  mode: ConnectionMode;
  hostUrl: string | null;
  error: string | null;
  connect: (url: string) => void;
  disconnect: () => void;
  setConnected: () => void;
  setError: (error: string) => void;
  useMockMode: () => void;
}

export const useConnectionStore = create<ConnectionState>((set) => ({
  status: "disconnected",
  mode: "mock",
  hostUrl: null,
  error: null,
  connect: (url: string) => {
    try {
      new URL(url);
    } catch {
      console.error("[ahp:conn]", "invalid URL:", url);
      set({ status: "disconnected", error: "Invalid connection URL" });
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
  setError: (error: string) => {
    console.error("[ahp:conn]", "error:", error);
    set({ status: "disconnected", error });
  },
  useMockMode: () => {
    console.info("[ahp:conn]", "mock mode");
    set({ status: "connected", mode: "mock", hostUrl: "mock://localhost", error: null });
  },
}));
