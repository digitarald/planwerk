"use client";

import { useShallow } from "zustand/react/shallow";
import { Droppable } from "@hello-pangea/dnd";

import { KanbanCard } from "@/components/board/kanban-card";
import { SessionCreator } from "@/components/board/session-creator";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useBoardStore, selectFilteredCards } from "@/lib/store/board-store";
import { Column } from "@/lib/types";
import { cn } from "@/lib/utils";

interface KanbanColumnProps {
  column: Column;
}

export function KanbanColumn({ column }: KanbanColumnProps) {
  const cards = useBoardStore(useShallow((state) => selectFilteredCards(state).filter((c) => c.phase === column.id)));
  const isOverWip = column.wipLimit ? cards.length > column.wipLimit : false;
  const isEmpty = cards.length === 0;

  return (
    <section
      className={cn(
        "flex flex-col transition-[min-width,max-width,flex] duration-200",
        isEmpty
          ? "min-w-[60px] max-w-[60px] flex-shrink-0"
          : "min-w-[180px] max-w-[300px] flex-1"
      )}
      data-column-id={column.id}
    >
      <div className={cn("flex items-start gap-3 px-3 py-2", isEmpty && "flex-col items-center gap-1 px-1")}>
        <div className="min-w-0 flex-1">
          <h2 className={cn(
            "text-xs font-semibold tracking-[0.18em] text-muted-foreground uppercase",
            isEmpty && "[writing-mode:vertical-lr] rotate-180 text-center"
          )}>
            {column.title}
          </h2>
          {!isEmpty && (
            <p className="mt-0.5 text-[11px] text-muted-foreground/80">
              {column.description}
            </p>
          )}
        </div>
        {!isEmpty && (
          <span
            className={cn(
              "rounded-full px-1.5 py-0.5 text-[10px] font-medium",
              isOverWip ? "bg-amber-100 text-amber-700" : "bg-muted text-muted-foreground"
            )}
          >
            {cards.length}
            {column.wipLimit && `/${column.wipLimit}`}
          </span>
        )}
        {(() => {
          const attentionCount = cards.filter((c) => c.attention !== "none").length;
          if (attentionCount === 0) return null;
          return <span className="h-2 w-2 animate-pulse rounded-full bg-amber-500" />;
        })()}
      </div>

      <Droppable droppableId={column.id}>
        {(provided, snapshot) => (
          <ScrollArea className="min-h-0 flex-1">
            <div
              ref={provided.innerRef}
              {...provided.droppableProps}
              className={cn(
                "min-h-full rounded-xl border border-transparent px-2 pb-2 transition-colors",
                snapshot.isDraggingOver && "border-primary/20 bg-primary/5"
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
