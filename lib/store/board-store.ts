import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { KanbanCard, Phase } from "@/lib/types";

// Sentinel value for filtering cards with no project
export const UNASSIGNED_WORKSPACE = "__unassigned__";

interface BoardState {
  cards: KanbanCard[];
  detailCardId: string | null;
  workspaceFilters: Set<string>;
  hideDone: boolean;
  setDetailCard: (id: string | null) => void;
  setCards: (cards: KanbanCard[]) => void;
  updateCard: (id: string, card: Partial<KanbanCard>) => void;
  addCard: (card: KanbanCard) => void;
  removeCard: (id: string) => void;
  getCard: (id: string) => KanbanCard | undefined;
  getCardsByPhase: (phase: Phase) => KanbanCard[];
  moveCard: (cardId: string, toPhase: Phase) => void;
  toggleWorkspaceFilter: (path: string) => void;
  clearWorkspaceFilters: () => void;
  toggleHideDone: () => void;
}

// Fields derived locally — preserved when the card has manualOverride set
// (e.g., from a DnD phase move), otherwise accepted from server enrichment
const LOCAL_OVERRIDE_FIELDS: ReadonlySet<keyof KanbanCard> = new Set([
  "phase", "gateStatus",
]);

/**
 * Merge an incoming card update with the existing card.
 * AHP-owned fields always overwrite. When a card has manualOverride set
 * (e.g., from a DnD phase move), phase and gateStatus are preserved.
 * All other fields accept incoming values, falling back to existing.
 */
function mergeCard(existing: KanbanCard, incoming: Partial<KanbanCard>): KanbanCard {
  const merged = { ...existing };

  for (const key of Object.keys(incoming) as Array<keyof KanbanCard>) {
    const value = incoming[key];
    if (value === undefined) continue;

    // When manually overridden, protect phase/gateStatus from server clobbering
    if (existing.manualOverride && LOCAL_OVERRIDE_FIELDS.has(key)) {
      continue;
    }

    (merged as Record<string, unknown>)[key] = value;
  }

  return merged;
}

/** Remove stale filter paths that no longer match any visible card */
function normalizeWorkspaceFilters(cards: KanbanCard[], filters: Set<string>, hideDone: boolean): Set<string> {
  if (filters.size === 0) return filters;
  const visible = hideDone ? cards.filter((c) => !c.isArchived) : cards;
  const next = new Set<string>();
  for (const f of filters) {
    if (f === UNASSIGNED_WORKSPACE) {
      if (visible.some((c) => !c.project)) next.add(f);
    } else {
      if (visible.some((c) => c.project?.path === f)) next.add(f);
    }
  }
  return next.size === filters.size ? filters : next;
}

/** Selector: derive filtered cards from cards + hideDone + workspaceFilters */
export function selectFilteredCards(state: BoardState): KanbanCard[] {
  const { cards, hideDone, workspaceFilters } = state;
  const visible = hideDone ? cards.filter((c) => !c.isArchived) : cards;
  if (workspaceFilters.size === 0) return visible;
  return visible.filter((c) => {
    if (!c.project) return workspaceFilters.has(UNASSIGNED_WORKSPACE);
    return workspaceFilters.has(c.project.path);
  });
}

/** Whether the current filter shows more than one workspace (or all) */
export function selectShowWorkspaceTags(state: BoardState): boolean {
  return state.workspaceFilters.size !== 1 || state.workspaceFilters.has(UNASSIGNED_WORKSPACE);
}

/** Workspace info with count and attention, sorted by most recent activity */
export interface WorkspaceInfo {
  name: string;
  path: string;
  count: number;
  hasAttention: boolean;
  latestModifiedAt: number;
}

// Stable cache for selectWorkspaces to avoid new object references on unchanged data
let _prevCards: KanbanCard[] = [];
let _prevHideDone = true;
let _prevWorkspaces: WorkspaceInfo[] = [];

/** Selector: unique workspaces with counts, sorted by most recent activity (memoized) */
export function selectWorkspaces(state: BoardState): WorkspaceInfo[] {
  if (state.cards === _prevCards && state.hideDone === _prevHideDone) return _prevWorkspaces;

  const cards = state.hideDone ? state.cards.filter((c) => !c.isArchived) : state.cards;
  const map = new Map<string, WorkspaceInfo>();
  for (const card of cards) {
    if (!card.project) continue;
    const existing = map.get(card.project.path);
    if (existing) {
      existing.count++;
      if (card.attention !== "none") existing.hasAttention = true;
      if (card.modifiedAt > existing.latestModifiedAt) existing.latestModifiedAt = card.modifiedAt;
    } else {
      map.set(card.project.path, {
        name: card.project.name,
        path: card.project.path,
        count: 1,
        hasAttention: card.attention !== "none",
        latestModifiedAt: card.modifiedAt,
      });
    }
  }
  const result = Array.from(map.values()).sort((a, b) => b.latestModifiedAt - a.latestModifiedAt);

  // Reuse previous array if structurally equal
  if (
    result.length === _prevWorkspaces.length &&
    result.every((w, i) =>
      w.path === _prevWorkspaces[i].path &&
      w.name === _prevWorkspaces[i].name &&
      w.count === _prevWorkspaces[i].count &&
      w.hasAttention === _prevWorkspaces[i].hasAttention &&
      w.latestModifiedAt === _prevWorkspaces[i].latestModifiedAt
    )
  ) {
    _prevCards = state.cards;
    _prevHideDone = state.hideDone;
    return _prevWorkspaces;
  }

  _prevCards = state.cards;
  _prevHideDone = state.hideDone;
  _prevWorkspaces = result;
  return result;
}

/** Whether any visible cards lack a project */
export function selectHasUnassigned(state: BoardState): boolean {
  const cards = state.hideDone ? state.cards.filter((c) => !c.isArchived) : state.cards;
  return cards.some((c) => !c.project);
}

/** Count of archived cards (for the toggle badge) */
export function selectArchivedCount(state: BoardState): number {
  return state.cards.filter((c) => c.isArchived).length;
}

export const useBoardStore = create<BoardState>()(
  persist(
    (set, get) => ({
      cards: [],
      detailCardId: null,
      workspaceFilters: new Set(),
      hideDone: true,
      setDetailCard: (id) => set({ detailCardId: id }),
      setCards: (cards) =>
        set((state) => ({
          cards,
          workspaceFilters: normalizeWorkspaceFilters(cards, state.workspaceFilters, state.hideDone),
        })),
      updateCard: (id, incoming) =>
        set((state) => {
          const cards = state.cards.map((existing) => {
            if (existing.id !== id) return existing;
            return mergeCard(existing, incoming);
          });
          return { cards, workspaceFilters: normalizeWorkspaceFilters(cards, state.workspaceFilters, state.hideDone) };
        }),
      addCard: (card) =>
        set((state) => ({
          cards: [...state.cards, card],
        })),
      removeCard: (id) =>
        set((state) => {
          const cards = state.cards.filter((c) => c.id !== id);
          return { cards, workspaceFilters: normalizeWorkspaceFilters(cards, state.workspaceFilters, state.hideDone) };
        }),
      getCard: (id) => get().cards.find((c) => c.id === id),
      getCardsByPhase: (phase) => get().cards.filter((card) => card.phase === phase),
      moveCard: (cardId, toPhase) =>
        set((state) => ({
          cards: state.cards.map((card) =>
            card.id === cardId ? { ...card, phase: toPhase, manualOverride: true } : card
          ),
        })),
      toggleWorkspaceFilter: (path) =>
        set((state) => {
          const next = new Set(state.workspaceFilters);
          if (next.has(path)) next.delete(path);
          else next.add(path);
          return { workspaceFilters: next };
        }),
      clearWorkspaceFilters: () => set({ workspaceFilters: new Set() }),
      toggleHideDone: () => set((state) => {
        const hideDone = !state.hideDone;
        return {
          hideDone,
          workspaceFilters: normalizeWorkspaceFilters(state.cards, state.workspaceFilters, hideDone),
        };
      }),
    }),
    {
      name: "planwerk-board",
      storage: createJSONStorage(() => sessionStorage),
      partialize: (state) => ({
        workspaceFilters: Array.from(state.workspaceFilters),
        hideDone: state.hideDone,
      }),
      merge: (persisted, current) => ({
        ...current,
        ...(persisted && typeof persisted === "object"
          ? {
              ...("workspaceFilters" in persisted
                ? {
                    workspaceFilters: new Set(
                      (persisted as { workspaceFilters?: string[] }).workspaceFilters ?? [],
                    ),
                  }
                : {}),
              ...("hideDone" in persisted
                ? { hideDone: (persisted as { hideDone?: boolean }).hideDone ?? true }
                : {}),
            }
          : {}),
      }),
    },
  ),
);
