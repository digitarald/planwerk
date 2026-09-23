"use client";

import { useEffect } from "react";
import { RefreshCw } from "lucide-react";

import { InboxFeed } from "@/components/inbox/inbox-feed";
import { InboxFilters } from "@/components/inbox/inbox-filters";
import { Button } from "@/components/ui/button";
import { useBoardStore } from "@/lib/store/board-store";
import { useConnectionStore } from "@/lib/store/connection-store";
import {
  filterInboxItemsByWorkspace,
  useInboxStore,
  visibleInboxItems,
} from "@/lib/store/inbox-store";

export function InboxWorkspace() {
  const hostUrl = useConnectionStore((state) => state.hostUrl);
  const status = useConnectionStore((state) => state.status);
  const hydrate = useInboxStore((state) => state.hydrate);
  const isLoading = useInboxStore((state) => state.isLoading);

  useEffect(() => {
    if (status !== "connected") return;

    const refresh = () => void hydrate(hostUrl ?? undefined);
    refresh();
    const interval = window.setInterval(refresh, 5 * 60 * 1000);
    return () => window.clearInterval(interval);
  }, [hostUrl, hydrate, status]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        target?.matches("input, textarea, select, [contenteditable='true']")
        || event.metaKey
        || event.ctrlKey
        || event.altKey
      ) {
        return;
      }

      const state = useInboxStore.getState();
      const boardState = useBoardStore.getState();
      const items = filterInboxItemsByWorkspace(
        visibleInboxItems(state),
        boardState.cards,
        boardState.workspaceFilters,
      );
      const index = items.findIndex((item) => item.id === state.selectedId);
      const selected = items[index];

      if (event.key === "j" || event.key === "ArrowDown") {
        event.preventDefault();
        const nextIndex = index < 0 ? 0 : Math.min(index + 1, items.length - 1);
        state.selectItem(items[nextIndex]?.id ?? null);
      } else if (event.key === "k" || event.key === "ArrowUp") {
        event.preventDefault();
        state.selectItem(items[Math.max(index - 1, 0)]?.id ?? null);
      } else if (selected && event.key.toLowerCase() === "e") {
        event.preventDefault();
        void state.mutateItem(selected.id, { action: "read" });
      } else if (selected && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void state.mutateItem(selected.id, {
          action: "snooze",
          snoozedUntil: Date.now() + 60 * 60 * 1000,
        });
      } else if (selected && event.key.toLowerCase() === "p") {
        event.preventDefault();
        void state.mutateItem(
          selected.id,
          selected.pinnedAt ? { action: "unpin" } : { action: "pin" },
        );
      } else if (selected && event.key.toLowerCase() === "o") {
        event.preventDefault();
        useBoardStore.getState().setDetailCard(selected.cardId);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <section className="@container/inbox flex h-full min-h-0 flex-col bg-[var(--pw-board-bg)]">
      <header className="h-10 shrink-0 border-b border-border/60 bg-background px-3 @min-[680px]/inbox:px-4">
        <div className="flex h-full min-w-0 items-center">
          <h2 className="w-14 shrink-0 text-[11px] font-semibold text-foreground">
            Feed
          </h2>
          <div className="min-w-0 flex-1">
            <InboxFilters />
          </div>
          <div className="ml-2">
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Refresh"
              title="Refresh"
              disabled={isLoading}
              onClick={() => void hydrate(hostUrl ?? undefined)}
            >
              <RefreshCw className={isLoading ? "motion-safe:animate-spin" : undefined} />
            </Button>
          </div>
        </div>
      </header>

      <InboxFeed />
    </section>
  );
}
