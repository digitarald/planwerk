"use client";

import { DragDropContext, type DropResult } from "@hello-pangea/dnd";

import { CardDetailModal } from "@/components/board/card-detail-modal";
import { KanbanColumn } from "@/components/board/kanban-column";
import { useOrchestratorStore } from "@/lib/store/orchestrator-store";
import { useBoardStore } from "@/lib/store/board-store";
import { COLUMNS, PHASE_ORDER, type GateStatus, type KanbanCard, type Phase } from "@/lib/types";

interface TransitionArgs {
  cardId: string;
  toPhase: Phase;
  projectPath?: string;
  projectName?: string;
  changesetRef: string;
  title: string;
  original: {
    phase: Phase;
    gateStatus: GateStatus;
    manualOverride?: boolean;
    modifiedAt: number;
  };
  generation: number;
  reconcileCard: (id: string, card: Partial<KanbanCard>) => void;
  addFeedItem: (item: {
    type: "alert";
    message: string;
    cardId?: string;
    cardTitle?: string;
    projectName?: string;
  }) => void;
}

/** Latest drag generation per card. A reconcile/rollback only applies if it is
 *  still the most recent drag for that card, so out-of-order responses from
 *  rapid successive drags can't clobber the user's latest action. */
const transitionGen = new Map<string, number>();

/** Persist a DnD phase move to the gate engine and reconcile the optimistic
 *  client update against the server's stored truth. Rolls back on failure so
 *  the board never shows a phase the system doesn't actually hold. */
async function persistTransition({
  cardId,
  toPhase,
  projectPath,
  projectName,
  changesetRef,
  title,
  original,
  generation,
  reconcileCard,
  addFeedItem,
}: TransitionArgs): Promise<void> {
  const isLatest = () => transitionGen.get(cardId) === generation;
  try {
    const res = await fetch("/api/gates/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "transition", cardId, toPhase, projectPath, changesetRef }),
    });

    if (!res.ok) throw new Error(`transition failed: ${res.status}`);

    const data = (await res.json()) as {
      newPhase: Phase;
      gateStatus: GateStatus;
      manualOverride: boolean;
    };

    // Ignore a stale response superseded by a newer drag on the same card.
    if (!isLatest()) return;

    // Reconcile to the persisted truth (usually matches the optimistic update).
    reconcileCard(cardId, {
      phase: data.newPhase,
      gateStatus: data.gateStatus,
      manualOverride: data.manualOverride,
    });
  } catch {
    // A newer drag has superseded this one — don't roll back to a stale state.
    if (!isLatest()) return;
    // Roll back to the pre-drag state and tell the user the move didn't stick.
    reconcileCard(cardId, {
      phase: original.phase,
      gateStatus: original.gateStatus,
      manualOverride: original.manualOverride ?? false,
      modifiedAt: original.modifiedAt,
    });
    addFeedItem({
      type: "alert",
      message: `Couldn't save the move for "${title}" — reverted to ${original.phase.toUpperCase()}`,
      cardId,
      cardTitle: title,
      projectName,
    });
  }
}

export function KanbanBoard() {
  const getCard = useBoardStore((state) => state.getCard);
  const reconcileCard = useBoardStore((state) => state.reconcileCard);
  const addFeedItem = useOrchestratorStore((state) => state.addFeedItem);

  // Subscribe to the actual card object (not just its id) so the open detail
  // modal re-renders when live SSE updates mutate the card — e.g. a sent
  // message starts a new turn and the runtime/activity/last response change.
  const detailCard = useBoardStore((state) =>
    state.detailCardId
      ? state.cards.find((c) => c.id === state.detailCardId)
      : undefined
  );

  const handleDragEnd = (result: DropResult) => {
    if (!result.destination) return;

    const toPhase = result.destination.droppableId as Phase;
    const card = getCard(result.draggableId);

    if (!card) return;

    const fromIdx = PHASE_ORDER.indexOf(card.phase);
    const toIdx = PHASE_ORDER.indexOf(toPhase);

    if (fromIdx === toIdx) return;

    // Snapshot original state so we can roll back if the server rejects the move.
    const original = {
      phase: card.phase,
      gateStatus: card.gateStatus,
      manualOverride: card.manualOverride,
      modifiedAt: card.modifiedAt,
    };
    const fromPhase = card.phase;
    const modifiedAt = Date.now();
    const forward = toIdx > fromIdx;

    // Mark this as the latest drag for the card so out-of-order responses from
    // earlier drags can't clobber it.
    const generation = (transitionGen.get(card.id) ?? 0) + 1;
    transitionGen.set(card.id, generation);

    // Optimistic update for a snappy board, reconciled against server truth
    // below. Uses reconcileCard (force-apply) because the drag is the
    // authoritative local intent — mergeCard's manualOverride protection would
    // otherwise drop a backward move on a card that's currently overridden.
    // Forward moves are an override (gates not run), so status is "pending".
    reconcileCard(card.id, {
      phase: toPhase,
      gateStatus: "pending",
      manualOverride: forward,
      modifiedAt,
    });

    if (forward) {
      addFeedItem({
        type: "alert",
        message: `Manual override: "${card.title}" moved ${fromPhase.toUpperCase()} → ${toPhase.toUpperCase()} — gates not verified for this move`,
        cardId: card.id,
        cardTitle: card.title,
        projectName: card.project?.name,
      });
    } else {
      addFeedItem({
        type: "transition",
        message: `"${card.title}" moved back to ${toPhase.toUpperCase()} for rework`,
        cardId: card.id,
        cardTitle: card.title,
        projectName: card.project?.name,
      });
    }

    // Persist the transition and reconcile with the gate engine's stored truth.
    // changeset_ref mirrors gate-engine.computeChangesetRef so staleness lines up.
    const changesetRef = `${card.filesChanged}:${card.additions}:${card.deletions}:${modifiedAt}`;
    void persistTransition({
      cardId: card.id,
      toPhase,
      projectPath: card.project?.path,
      projectName: card.project?.name,
      changesetRef,
      generation,
      reconcileCard,
      addFeedItem,
      title: card.title,
      original,
    });
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <DragDropContext onDragEnd={handleDragEnd}>
        <div className="flex min-h-0 flex-1 gap-3 p-4 pt-3">
          {COLUMNS.map((column) => (
            <KanbanColumn key={column.id} column={column} />
          ))}
        </div>
      </DragDropContext>

      {detailCard && <CardDetailModal key={detailCard.id} card={detailCard} />}
    </div>
  );
}
