"use client";

import { useEffect, useState } from "react";
import { Inbox as InboxIcon, RotateCcw } from "lucide-react";
import { useShallow } from "zustand/react/shallow";

import { InboxFeedItem } from "@/components/inbox/inbox-feed-item";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { useBoardStore } from "@/lib/store/board-store";
import { useConnectionStore } from "@/lib/store/connection-store";
import {
  filterInboxItemsByWorkspace,
  useInboxStore,
  visibleInboxItems,
} from "@/lib/store/inbox-store";

function FeedSkeleton() {
  return (
    <div
      role="status"
      aria-label="Loading feed"
      className="w-full px-2 @min-[680px]/inbox:px-4"
    >
      {[0, 1, 2].map((index) => (
        <div
          key={index}
          className="grid grid-cols-[1.75rem_minmax(0,1fr)] gap-3 border-b border-border/60 px-2 py-3.5"
        >
          <Skeleton className="h-7 w-7 rounded-md" />
          <div className="space-y-2">
            <Skeleton className="h-2.5 w-28" />
            <Skeleton className={index === 1 ? "h-3.5 w-1/2" : "h-3.5 w-2/3"} />
            <Skeleton className="h-3 w-4/5" />
            <div className="flex gap-2">
              <Skeleton className="h-6 w-14 rounded" />
              <Skeleton className="h-6 w-12 rounded" />
            </div>
          </div>
        </div>
      ))}
      <span className="sr-only">Loading feed</span>
    </div>
  );
}

export function InboxFeed() {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  const hostUrl = useConnectionStore((state) => state.hostUrl);
  const visibleItems = useInboxStore(useShallow(visibleInboxItems));
  const selectedId = useInboxStore((state) => state.selectedId);
  const hydrate = useInboxStore((state) => state.hydrate);
  const isLoading = useInboxStore((state) => state.isLoading);
  const error = useInboxStore((state) => state.error);
  const { cards, workspaceFilters } = useBoardStore(useShallow((state) => ({
    cards: state.cards,
    workspaceFilters: state.workspaceFilters,
  })));
  const items = filterInboxItemsByWorkspace(
    visibleItems,
    cards,
    workspaceFilters,
  );
  const cardsById = new Map(cards.map((card) => [card.id, card]));

  if (isLoading && items.length === 0) return <FeedSkeleton />;

  if (error && items.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center px-6 text-center">
        <p className="text-xs font-medium text-foreground">
          Briefing feed unavailable
        </p>
        <p className="mt-1 max-w-64 text-[11px] leading-4 text-muted-foreground">
          {error}
        </p>
        <Button
          variant="outline"
          size="sm"
          className="mt-3"
          onClick={() => void hydrate(hostUrl ?? undefined)}
        >
          <RotateCcw />
          Retry
        </Button>
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center px-6 text-center">
        <div className="flex h-10 w-10 items-center justify-center rounded-full border border-border bg-background shadow-elevation-xs">
          <InboxIcon className="h-4 w-4 text-muted-foreground" />
        </div>
        <p className="mt-3 text-sm font-semibold text-foreground">
          You&apos;re caught up
        </p>
        <p className="mt-1 max-w-64 text-[12px] leading-5 text-muted-foreground">
          New decisions, reviews, and finished work will show up here.
        </p>
      </div>
    );
  }

  return (
    <ScrollArea className="min-h-0 flex-1">
      <div
        role="feed"
        aria-label="Agent feed"
        className="w-full px-2 @min-[680px]/inbox:px-4"
      >
        {items.map((item) => (
          <InboxFeedItem
            key={item.id}
            item={item}
            now={now}
            projectName={
              cardsById.get(item.cardId)?.project?.name ?? item.projectName
            }
            selected={item.id === selectedId}
          />
        ))}
      </div>
    </ScrollArea>
  );
}
