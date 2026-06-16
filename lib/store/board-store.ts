import { create } from "zustand";

import { KanbanCard, Phase } from "@/lib/types";

interface BoardState {
  cards: KanbanCard[];
  expandedCardId: string | null;
  setExpandedCard: (id: string | null) => void;
  setCards: (cards: KanbanCard[]) => void;
  updateCard: (id: string, card: KanbanCard) => void;
  addCard: (card: KanbanCard) => void;
  removeCard: (id: string) => void;
  getCard: (id: string) => KanbanCard | undefined;
  getCardsByPhase: (phase: Phase) => KanbanCard[];
  moveCard: (cardId: string, toPhase: Phase) => void;
}

export const useBoardStore = create<BoardState>((set, get) => ({
  cards: [],
  expandedCardId: null,
  setExpandedCard: (id) => set({ expandedCardId: id }),
  setCards: (cards) => set({ cards }),
  updateCard: (id, card) =>
    set((state) => ({
      cards: state.cards.map((c) => (c.id === id ? card : c)),
    })),
  addCard: (card) =>
    set((state) => ({
      cards: [...state.cards, card],
    })),
  removeCard: (id) =>
    set((state) => ({
      cards: state.cards.filter((c) => c.id !== id),
    })),
  getCard: (id) => get().cards.find((c) => c.id === id),
  getCardsByPhase: (phase) => get().cards.filter((card) => card.phase === phase),
  moveCard: (cardId, toPhase) =>
    set((state) => ({
      cards: state.cards.map((card) =>
        card.id === cardId ? { ...card, phase: toPhase } : card
      ),
    })),
}));
