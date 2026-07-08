import { create } from "zustand";

interface UIState {
  welcomeOpen: boolean;
  openWelcome: () => void;
  closeWelcome: () => void;
  setWelcomeOpen: (open: boolean) => void;
}

export const useUIStore = create<UIState>()((set) => ({
  welcomeOpen: false,
  openWelcome: () => set({ welcomeOpen: true }),
  closeWelcome: () => set({ welcomeOpen: false }),
  setWelcomeOpen: (open: boolean) => set({ welcomeOpen: open }),
}));
