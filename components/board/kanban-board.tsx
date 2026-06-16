"use client";

import { DragDropContext, type DropResult } from "@hello-pangea/dnd";

import { KanbanColumn } from "@/components/board/kanban-column";
import { useOrchestratorStore } from "@/lib/store/orchestrator-store";
import { useBoardStore } from "@/lib/store/board-store";
import { COLUMNS, type Phase } from "@/lib/types";

const PHASE_ORDER: Phase[] = ["define", "plan", "build", "verify", "review", "ship"];

export function KanbanBoard() {
  const getCard = useBoardStore((state) => state.getCard);
  const updateCard = useBoardStore((state) => state.updateCard);
  const addFeedItem = useOrchestratorStore((state) => state.addFeedItem);

  const handleDragEnd = (result: DropResult) => {
    if (!result.destination) return;

    const toPhase = result.destination.droppableId as Phase;
    const card = getCard(result.draggableId);

    if (!card) return;

    const fromIdx = PHASE_ORDER.indexOf(card.phase);
    const toIdx = PHASE_ORDER.indexOf(toPhase);
    const modifiedAt = Date.now();

    if (fromIdx === toIdx) return;

    if (toIdx > fromIdx) {
      updateCard(card.id, {
        ...card,
        phase: toPhase,
        gateStatus: "evaluating",
        manualOverride: true,
        modifiedAt,
      });
      addFeedItem({
        type: "alert",
        message: `Manual override: "${card.title}" moved ${card.phase.toUpperCase()} → ${toPhase.toUpperCase()} while gates are being checked`,
        cardId: card.id,
      });
      return;
    }

    updateCard(card.id, {
      ...card,
      phase: toPhase,
      gateStatus: "pending",
      manualOverride: false,
      modifiedAt,
    });
    addFeedItem({
      type: "transition",
      message: `"${card.title}" moved back to ${toPhase.toUpperCase()} for rework`,
      cardId: card.id,
    });
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <header className="border-b border-border px-5 py-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-[11px] font-semibold tracking-[0.24em] text-muted-foreground uppercase">
              Planwerk
            </p>
            <h1 className="mt-1 text-xl font-semibold tracking-tight">
              SDLC Kanban Board
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Six-phase workflow for defining, planning, building, verifying,
              reviewing, and shipping work.
            </p>
          </div>
        </div>
      </header>

      <DragDropContext onDragEnd={handleDragEnd}>
        <div className="flex min-h-0 flex-1 gap-0 overflow-x-auto p-4">
          {COLUMNS.map((column) => (
            <KanbanColumn key={column.id} column={column} />
          ))}
        </div>
      </DragDropContext>
    </div>
  );
}
