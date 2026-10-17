export interface DesktopHost {
  hostUrl: string;
  connected: boolean;
  running: number;
}

// Route bundles must share the live registry, not copies of its last snapshot.
const state = globalThis as typeof globalThis & {
  planwerkDesktopHosts?: () => DesktopHost[];
};

export function registerDesktopHosts(source: () => DesktopHost[]): void {
  state.planwerkDesktopHosts = source;
}

export function desktopHosts(): DesktopHost[] {
  return state.planwerkDesktopHosts?.() ?? [];
}
