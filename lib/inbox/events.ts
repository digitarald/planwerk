import type { InboxStreamEvent } from "./types.ts";

type InboxEventListener = (event: InboxStreamEvent) => void;

export function inboxEventMatchesHost(
  event: InboxStreamEvent,
  hostUrl: string | undefined,
): boolean {
  return hostUrl === undefined || event.hostUrl === hostUrl;
}

class InboxEventBus {
  private readonly listeners = new Set<InboxEventListener>();

  subscribe(listener: InboxEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  publish(event: InboxStreamEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}

const globalInboxEvents = globalThis as typeof globalThis & {
  __planwerkInboxEvents?: InboxEventBus;
};

export const inboxEvents =
  globalInboxEvents.__planwerkInboxEvents ??= new InboxEventBus();
