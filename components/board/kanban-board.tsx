"use client";

import { DragDropContext, type DropResult } from "@hello-pangea/dnd";

import { KanbanColumn } from "@/components/board/kanban-column";
import { useOrchestratorStore } from "@/lib/store/orchestrator-store";
import { useBoardStore } from "@/lib/store/board-store";
import { COLUMNS, PHASE_ORDER, type Phase } from "@/lib/types";

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
    <div className="flex h-full min-h-0 flex-col">
      <DragDropContext onDragEnd={handleDragEnd}>
        <div className="flex min-h-0 flex-1 gap-2 p-4 pt-3">
          {COLUMNS.map((column) => (
            <KanbanColumn key={column.id} column={column} />
          ))}
        </div>
      </DragDropContext>
    </div>
  );
}
