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
      set({ status: "disconnected", error: "Invalid connection URL" });
      return;
    }
    set({ status: "reconnecting", mode: "remote", hostUrl: url, error: null });
  },
  disconnect: () => {
    set({ status: "disconnected", mode: "mock", hostUrl: null, error: null });
  },
  setConnected: () => {
    set({ status: "connected", error: null });
  },
  setError: (error: string) => {
    set({ status: "disconnected", error });
  },
  useMockMode: () => {
    set({ status: "connected", mode: "mock", hostUrl: "mock://localhost", error: null });
  },
}));
