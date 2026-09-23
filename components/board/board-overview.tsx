"use client";

import { ArrowUpRight, CirclePause, Loader2, MessageCircleWarning, XCircle } from "lucide-react";
import { useShallow } from "zustand/react/shallow";

import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useBoardStore, selectFilteredCards } from "@/lib/store/board-store";
import { useInboxStore } from "@/lib/store/inbox-store";
import { useUIStore } from "@/lib/store/ui-store";
import { COLUMNS, type KanbanCard } from "@/lib/types";
import { ATTENTION_META } from "@/lib/utils/attention";
import { cn } from "@/lib/utils";

function RuntimeGlyph({ card }: { card: KanbanCard }) {
  switch (card.runtime) {
    case "running":
      return <Loader2 className="h-3 w-3 animate-spin text-primary" aria-label="Running" />;
    case "input-needed":
      return <MessageCircleWarning className="h-3 w-3 text-amber-600" aria-label="Needs input" />;
    case "error":
      return <XCircle className="h-3 w-3 text-red-600" aria-label="Error" />;
    case "idle":
      return <CirclePause className="h-3 w-3 text-muted-foreground/55" aria-label="Idle" />;
  }
}

export function BoardOverview() {
  const cards = useBoardStore(useShallow(selectFilteredCards));
  const setDetailCard = useBoardStore((state) => state.setDetailCard);
  const selectedInboxItem = useInboxStore((state) =>
    state.items.find((item) => item.id === state.selectedId),
  );
  const focusCard = useInboxStore((state) => state.focusCard);
  const setWorkspaceMode = useUIStore((state) => state.setWorkspaceMode);

  const openCard = (cardId: string) => {
    if (!focusCard(cardId)) setDetailCard(cardId);
  };

  return (
    <section className="flex h-full min-h-0 flex-col border-l border-border/70 bg-muted/20">
      <header className="flex h-11 shrink-0 items-center justify-between border-b border-border/60 bg-background px-3">
        <div>
          <h2 className="text-xs font-semibold text-foreground">Board</h2>
          <p className="text-[9px] text-muted-foreground">Where work is moving</p>
        </div>
        <Button
          variant="ghost"
          size="xs"
          onClick={() => setWorkspaceMode("board")}
        >
          Expand
          <ArrowUpRight />
        </Button>
      </header>
      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-1.5 p-2">
          {COLUMNS.map((column) => {
            const phaseCards = cards
              .filter((card) => card.phase === column.id && !card.isArchived)
              .sort((a, b) => b.modifiedAt - a.modifiedAt);
            const attentionCount = phaseCards.filter((card) => card.attention !== "none").length;
            return (
              <section key={column.id} className="rounded-lg border border-border/60 bg-background/75">
                <div className="flex items-center gap-2 border-b border-border/50 px-2.5 py-2">
                  <h3 className="text-[10px] font-semibold text-foreground/80">{column.title}</h3>
                  <span className="rounded bg-muted px-1 text-[9px] tabular-nums text-muted-foreground">
                    {phaseCards.length}
                  </span>
                  {attentionCount > 0 && (
                    <span className="ml-auto text-[9px] font-medium text-amber-700 dark:text-amber-400">
                      {attentionCount} need you
                    </span>
                  )}
                </div>
                {phaseCards.length === 0 ? (
                  <p className="px-2.5 py-2 text-[9px] text-muted-foreground/60">No active work</p>
                ) : (
                  <div className="divide-y divide-border/45">
                    {phaseCards.slice(0, 4).map((card) => {
                      const selected = selectedInboxItem?.cardId === card.id;
                      const attention = card.attention !== "none"
                        ? ATTENTION_META[card.attention]
                        : null;
                      return (
                        <button
                          key={card.id}
                          type="button"
                          onClick={() => openCard(card.id)}
                          className={cn(
                            "flex w-full items-center gap-2 px-2.5 py-2 text-left transition-colors hover:bg-muted/60",
                            selected && "bg-primary/7 ring-1 ring-inset ring-primary/20",
                          )}
                        >
                          <RuntimeGlyph card={card} />
                          <span className="min-w-0 flex-1 truncate text-[10px] font-medium text-foreground/85">
                            {card.title}
                          </span>
                          {attention && (
                            <attention.Icon
                              className={cn("h-3 w-3 shrink-0", attention.text)}
                              aria-label={attention.label}
                            />
                          )}
                        </button>
                      );
                    })}
                    {phaseCards.length > 4 && (
                      <button
                        type="button"
                        className="w-full px-2.5 py-1.5 text-left text-[9px] text-muted-foreground hover:text-foreground"
                        onClick={() => setWorkspaceMode("board")}
                      >
                        +{phaseCards.length - 4} more
                      </button>
                    )}
                  </div>
                )}
              </section>
            );
          })}
        </div>
      </ScrollArea>
    </section>
  );
}

export function BoardPhaseStrip() {
  const cards = useBoardStore(useShallow(selectFilteredCards));
  const setWorkspaceMode = useUIStore((state) => state.setWorkspaceMode);

  return (
    <button
      type="button"
      onClick={() => setWorkspaceMode("board")}
      className="flex h-9 w-full shrink-0 items-center border-b border-border/60 bg-muted/25 px-3 text-left transition-colors duration-150 hover:bg-muted/45 min-[1041px]:hidden"
      aria-label="Open board"
    >
      <span className="w-14 shrink-0 text-[11px] font-semibold text-foreground/75">
        Board
      </span>
      {COLUMNS.map((column) => {
        const phaseCards = cards.filter(
          (card) => card.phase === column.id && !card.isArchived,
        );
        const needsAttention = phaseCards.some((card) => card.attention !== "none");
        return (
          <span
            key={column.id}
            className="flex min-w-0 flex-1 items-center justify-center gap-1.5 border-l border-border/60 px-2 first:border-l-0"
          >
            <span className="truncate text-[10px] font-medium text-muted-foreground">
              {column.title}
            </span>
            <span
              className={cn(
                "inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full px-1 text-[9px] font-semibold tabular-nums",
                needsAttention
                  ? "bg-amber-500/10 text-amber-700 dark:bg-amber-400/10 dark:text-amber-400"
                  : "bg-background/80 text-foreground/65 ring-1 ring-border/50",
              )}
            >
              {phaseCards.length}
            </span>
          </span>
        );
      })}
    </button>
  );
}
