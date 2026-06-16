import { create } from "zustand";

export type ConnectionStatus = "connected" | "reconnecting" | "disconnected";

interface ConnectionState {
  status: ConnectionStatus;
  hostUrl: string | null;
  error: string | null;
  connect: (url: string) => void;
  disconnect: () => void;
  useMockMode: () => void;
}

let connectTimer: ReturnType<typeof setTimeout> | null = null;

function clearConnectTimer() {
  if (connectTimer) {
    clearTimeout(connectTimer);
    connectTimer = null;
  }
}

export const useConnectionStore = create<ConnectionState>((set) => ({
  status: "disconnected",
  hostUrl: null,
  error: null,
  connect: (url: string) => {
    clearConnectTimer();
    set({ status: "reconnecting", hostUrl: url, error: null });

    // Stub for future AHP WebSocket connection lifecycle.
    connectTimer = setTimeout(() => {
      set({ status: "connected" });
      connectTimer = null;
    }, 1500);
  },
  disconnect: () => {
    clearConnectTimer();
    set({ status: "disconnected", hostUrl: null, error: null });
  },
  useMockMode: () => {
    clearConnectTimer();
    set({ status: "connected", hostUrl: "mock://localhost", error: null });
  },
}));
