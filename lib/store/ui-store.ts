import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

export type WorkspaceMode = "inbox" | "split" | "board" | "flightdeck";

interface UIState {
  welcomeOpen: boolean;
  workspaceMode: WorkspaceMode;
  coordinatorOpen: boolean;
  openWelcome: () => void;
  closeWelcome: () => void;
  setWelcomeOpen: (open: boolean) => void;
  setWorkspaceMode: (mode: WorkspaceMode) => void;
  openCoordinator: () => void;
  closeCoordinator: () => void;
  setCoordinatorOpen: (open: boolean) => void;
}

export const useUIStore = create<UIState>()(
  persist(
    (set) => ({
      welcomeOpen: false,
      workspaceMode: "split",
      coordinatorOpen: false,
      openWelcome: () => set({ welcomeOpen: true }),
      closeWelcome: () => set({ welcomeOpen: false }),
      setWelcomeOpen: (open: boolean) => set({ welcomeOpen: open }),
      setWorkspaceMode: (workspaceMode) => set({ workspaceMode }),
      openCoordinator: () => set({ coordinatorOpen: true }),
      closeCoordinator: () => set({ coordinatorOpen: false }),
      setCoordinatorOpen: (coordinatorOpen) => set({ coordinatorOpen }),
    }),
    {
      name: "planwerk:ui",
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ workspaceMode: state.workspaceMode }),
    },
  ),
);
