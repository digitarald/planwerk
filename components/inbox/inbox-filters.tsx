"use client";

import { useShallow } from "zustand/react/shallow";

import { useBoardStore } from "@/lib/store/board-store";
import {
  filterInboxItemsByWorkspace,
  inboxCountsFor,
  useInboxStore,
  type InboxFilter,
} from "@/lib/store/inbox-store";
import { cn } from "@/lib/utils";

const filters: Array<{
  id: InboxFilter;
  label: string;
  count: keyof ReturnType<typeof useInboxStore.getState>["counts"];
}> = [
  { id: "priority", label: "Priority", count: "priority" },
  { id: "unread", label: "New", count: "unread" },
  { id: "open", label: "Open", count: "open" },
  { id: "snoozed", label: "Snoozed", count: "snoozed" },
  { id: "done", label: "Done", count: "done" },
];

export function InboxFilters() {
  const filter = useInboxStore((state) => state.filter);
  const items = useInboxStore((state) => state.items);
  const serverCounts = useInboxStore((state) => state.counts);
  const { cards, workspaceFilters } = useBoardStore(useShallow((state) => ({
    cards: state.cards,
    workspaceFilters: state.workspaceFilters,
  })));
  const counts = workspaceFilters.size === 0
    ? serverCounts
    : inboxCountsFor(
        filterInboxItemsByWorkspace(items, cards, workspaceFilters),
      );
  const setFilter = useInboxStore((state) => state.setFilter);

  return (
    <nav
      aria-label="Filter feed"
      className="flex min-w-0 items-center overflow-x-auto scrollbar-none"
    >
      {filters.map(({ id, label, count }) => {
        const active = filter === id;
        const value = counts[count];
        return (
          <button
            key={id}
            type="button"
            aria-current={active ? "page" : undefined}
            aria-pressed={active}
            onClick={() => setFilter(id)}
            className={cn(
              "relative inline-flex h-10 shrink-0 items-center gap-1.5 px-3 text-[11px] font-medium transition-colors duration-150 after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:rounded-full after:transition-colors after:duration-150 active:bg-muted/80",
              active
                ? "text-primary after:bg-primary"
                : "text-muted-foreground after:bg-transparent hover:bg-muted/50 hover:text-foreground",
            )}
          >
            {label}
            {value > 0 && (
              <span
                className={cn(
                  "inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[9px] font-semibold tabular-nums",
                  active
                    ? "bg-primary/10 text-primary"
                    : "bg-muted text-muted-foreground",
                )}
              >
                {value}
              </span>
            )}
          </button>
        );
      })}
    </nav>
  );
}
