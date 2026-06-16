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

let activeSocket: WebSocket | null = null;
let connectTimer: ReturnType<typeof setTimeout> | null = null;

function cleanup() {
  if (connectTimer) {
    clearTimeout(connectTimer);
    connectTimer = null;
  }
  if (activeSocket) {
    activeSocket.close();
    activeSocket = null;
  }
}

export const useConnectionStore = create<ConnectionState>((set) => ({
  status: "disconnected",
  hostUrl: null,
  error: null,
  connect: (url: string) => {
    cleanup();
    set({ status: "reconnecting", hostUrl: url, error: null });

    // Attempt real WebSocket connection with timeout
    try {
      const ws = new WebSocket(url);
      activeSocket = ws;

      connectTimer = setTimeout(() => {
        // Timeout after 5s — connection failed
        ws.close();
        activeSocket = null;
        set({ status: "disconnected", error: "Connection timed out. Is the AHP host running?" });
      }, 5000);

      ws.addEventListener("open", () => {
        if (connectTimer) {
          clearTimeout(connectTimer);
          connectTimer = null;
        }
        set({ status: "connected", error: null });
      });

      ws.addEventListener("error", () => {
        cleanup();
        set({ status: "disconnected", error: "Could not connect. Is the AHP host running?" });
      });

      ws.addEventListener("close", () => {
        if (activeSocket === ws) {
          activeSocket = null;
          set((state) =>
            state.status === "connected"
              ? { status: "disconnected", error: "Connection lost" }
              : state
          );
        }
      });
    } catch {
      cleanup();
      set({ status: "disconnected", error: "Invalid connection URL" });
    }
  },
  disconnect: () => {
    cleanup();
    set({ status: "disconnected", hostUrl: null, error: null });
  },
  useMockMode: () => {
    cleanup();
    set({ status: "connected", hostUrl: "mock://localhost", error: null });
  },
}));
