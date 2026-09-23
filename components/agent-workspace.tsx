"use client";

import { BoardOverview, BoardPhaseStrip } from "@/components/board/board-overview";
import { CardDetailModal } from "@/components/board/card-detail-modal";
import { KanbanBoard } from "@/components/board/kanban-board";
import { InboxWorkspace } from "@/components/inbox/inbox-workspace";
import { useBoardStore } from "@/lib/store/board-store";
import { useUIStore } from "@/lib/store/ui-store";

export function AgentWorkspace() {
  const workspaceMode = useUIStore((state) => state.workspaceMode);
  const detailCard = useBoardStore((state) =>
    state.detailCardId
      ? state.cards.find((card) => card.id === state.detailCardId)
      : undefined,
  );

  const workspace = workspaceMode === "board"
    ? <KanbanBoard />
    : workspaceMode === "inbox"
      ? <InboxWorkspace />
      : (
          <div className="grid h-full min-h-0 grid-cols-[minmax(620px,1.75fr)_minmax(330px,0.9fr)] max-[1040px]:grid-cols-1">
            <div className="flex min-h-0 flex-col">
              <BoardPhaseStrip />
              <div className="min-h-0 flex-1">
                <InboxWorkspace />
              </div>
            </div>
            <div className="min-h-0 max-[1040px]:hidden">
              <BoardOverview />
            </div>
          </div>
        );

  return (
    <>
      {workspace}
      {detailCard && <CardDetailModal key={detailCard.id} card={detailCard} />}
    </>
  );
}
