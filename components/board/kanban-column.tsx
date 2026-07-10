"use client";

import { useShallow } from "zustand/react/shallow";
import { Droppable } from "@hello-pangea/dnd";
import { TriangleAlert } from "lucide-react";

import { KanbanCard } from "@/components/board/kanban-card";
import { SessionCreator } from "@/components/board/session-creator";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useBoardStore, selectFilteredCards } from "@/lib/store/board-store";
import { Column } from "@/lib/types";
import { ATTENTION_PRIORITY, ATTENTION_META } from "@/lib/utils/attention";
import { cn } from "@/lib/utils";

interface KanbanColumnProps {
  column: Column;
}

export function KanbanColumn({ column }: KanbanColumnProps) {
  const cards = useBoardStore(useShallow((state) => {
    const filtered = selectFilteredCards(state).filter((c) => c.phase === column.id);
    // Sort so the board reads by priority, not just recency: exceptions that
    // need a human float to the top of each column (error > conflict >
    // needs-human > stale), then healthy cards by recency, archived last.
    return filtered.sort((a, b) => {
      if (a.isArchived !== b.isArchived) return a.isArchived ? 1 : -1;
      if (!a.isArchived) {
        const attn = ATTENTION_PRIORITY[b.attention] - ATTENTION_PRIORITY[a.attention];
        if (attn !== 0) return attn;
      }
      return b.modifiedAt - a.modifiedAt;
    });
  }));
  const isOverWip = column.wipLimit ? cards.length > column.wipLimit : false;
  // The define column always hosts the SessionCreator ("New task"), so it must
  // never collapse to the 60px rail even when it has no cards.
  const isEmpty = cards.length === 0 && column.id !== "define";

  // Summarize the column's attention as a single severity-ranked pill so an
  // operator sees "2 cards need you in Build" at the header, in the color of
  // the most severe state present.
  const attentionCards = cards.filter((c) => !c.isArchived && c.attention !== "none");
  const topAttention = attentionCards.reduce<keyof typeof ATTENTION_META | null>((top, card) => {
    const level = card.attention as keyof typeof ATTENTION_META;
    if (!top || ATTENTION_META[level].rank > ATTENTION_META[top].rank) return level;
    return top;
  }, null);

  return (
    <section
      className={cn(
        "flex flex-col rounded-xl transition-[min-width,max-width,flex] duration-200",
        isEmpty
          ? "min-w-[60px] max-w-[60px] flex-shrink-0"
          : "@container/col min-w-[180px] max-w-[480px] flex-1 bg-[var(--pw-column-bg)]"
      )}
      data-column-id={column.id}
    >
      <div className={cn(
        "flex items-start gap-3 px-3 py-2 @min-[340px]/col:px-4 @min-[340px]/col:py-2.5",
        isEmpty && "flex-col items-center gap-1 px-1"
      )}>
        <div className="min-w-0 flex-1">
          <h2 className={cn(
            "text-xs font-semibold tracking-[0.18em] text-muted-foreground uppercase @min-[340px]/col:text-[13px]",
            isEmpty && "[writing-mode:vertical-lr] rotate-180 text-center"
          )}>
            {column.title}
          </h2>
          {!isEmpty && (
            <p className="mt-0.5 text-[11px] text-muted-foreground/80 @min-[420px]/col:text-xs">
              {column.description}
            </p>
          )}
        </div>
        {!isEmpty && topAttention && (() => {
          const { Icon, pill, label } = ATTENTION_META[topAttention];
          return (
            <span
              className={cn(
                "inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-semibold tabular-nums",
                pill
              )}
              title={`${attentionCards.length} ${attentionCards.length === 1 ? "card needs" : "cards need"} attention (${label})`}
            >
              <Icon className="h-3 w-3" />
              {attentionCards.length}
            </span>
          );
        })()}
        {!isEmpty && (
          <span
            className={cn(
              "inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium tabular-nums",
              isOverWip
                ? "bg-amber-500 font-semibold text-white ring-2 ring-amber-500/25"
                : "bg-muted text-muted-foreground"
            )}
            title={
              isOverWip
                ? `Over WIP limit: ${cards.length} of ${column.wipLimit} — flow is backing up`
                : undefined
            }
          >
            {isOverWip && <TriangleAlert className="h-3 w-3" />}
            {cards.length}
            {column.wipLimit && `/${column.wipLimit}`}
          </span>
        )}
      </div>

      <Droppable droppableId={column.id}>
        {(provided, snapshot) => (
          <ScrollArea className="min-h-0 flex-1">
            <div
              ref={provided.innerRef}
              {...provided.droppableProps}
              className={cn(
                "min-h-full rounded-xl border border-transparent px-2 pb-2 transition-all duration-200 @min-[340px]/col:px-3",
                snapshot.isDraggingOver && "border-primary/20 bg-primary/5 shadow-[inset_0_2px_8px_oklch(0.57_0.17_251/0.06)]"
              )}
            >
              <div className="space-y-2">
                {cards.map((card, index) => (
                  <KanbanCard key={card.id} card={card} index={index} />
                ))}
                {cards.length === 0 && !snapshot.isDraggingOver && !isEmpty && (
                  <div className="py-6 text-center text-[10px] text-muted-foreground/60">
                    No tasks
                  </div>
                )}
                {provided.placeholder}
              </div>
            </div>
          </ScrollArea>
        )}
      </Droppable>
      {column.id === "define" && (
        <div className="px-2 pb-2">
          <SessionCreator />
        </div>
      )}
    </section>
  );
}
