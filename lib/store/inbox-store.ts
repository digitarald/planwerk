import { create } from "zustand";

import { UNASSIGNED_WORKSPACE } from "@/lib/automation-scope";
import type { KanbanCard } from "@/lib/types";

export type InboxCategory = "action" | "review" | "read";
export type InboxWorkflowState = "open" | "resolved" | "snoozed" | "superseded";
export type InboxConfidence = "high" | "medium" | "low";
export type InboxAttention = "now" | "soon" | "routine";
export type InboxFilter = "priority" | "unread" | "open" | "snoozed" | "done";
export type InboxActionKind =
  | "mark-read"
  | "review"
  | "reply"
  | "approve"
  | "inspect"
  | "open-session"
  | "resolve";

export interface InboxSuggestedAction {
  id: string;
  label: string;
  kind: InboxActionKind;
  description?: string;
}

export interface InboxBriefing {
  message: string;
  recommendation: string;
  recommendationReason: string;
  defaultAction: InboxSuggestedAction;
  alternativeActions: InboxSuggestedAction[];
  attention: InboxAttention;
  synthesisStatus: "pending" | "generated" | "failed";
  outcome: string;
  trigger: string;
  evidenceSummary?: string;
  caveats: string[];
  confidence: InboxConfidence;
  freshness: {
    sourceRevision?: string;
    generatedAt: number;
    stale: boolean;
  };
  provenance: string;
}

export interface InboxItem {
  id: string;
  cardId: string;
  sourceKind: string;
  category: InboxCategory;
  workflowState: InboxWorkflowState;
  readAt: number | null;
  pinnedAt?: number | null;
  snoozedUntil?: number | null;
  priorityBand: number;
  priorityScore: number;
  priorityReasons: string[];
  title: string;
  projectName?: string;
  briefing: InboxBriefing;
  evidence: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export interface InboxCounts {
  priority: number;
  unread: number;
  open: number;
  snoozed: number;
  done: number;
}

type InboxMutation =
  | { action: "read" | "unread" | "resolve" | "unsnooze" | "pin" | "unpin" }
  | { action: "snooze"; snoozedUntil: number };

interface InboxState {
  items: InboxItem[];
  counts: InboxCounts;
  filter: InboxFilter;
  selectedId: string | null;
  isLoading: boolean;
  error: string | null;
  pendingIds: Set<string>;
  hydrate: (hostUrl?: string) => Promise<void>;
  setFilter: (filter: InboxFilter) => void;
  selectItem: (id: string | null) => void;
  focusCard: (cardId: string) => boolean;
  reconcileItem: (item: InboxItem) => void;
  removeItem: (id: string) => void;
  mutateItem: (id: string, mutation: InboxMutation) => Promise<InboxItem | null>;
}

const EMPTY_COUNTS: InboxCounts = {
  priority: 0,
  unread: 0,
  open: 0,
  snoozed: 0,
  done: 0,
};

function itemTimestamp(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Date.now();
}

function normalizeAction(value: unknown, fallback: InboxSuggestedAction): InboxSuggestedAction {
  if (!value || typeof value !== "object") return fallback;
  const action = value as Partial<InboxSuggestedAction>;
  return {
    id: typeof action.id === "string" ? action.id : fallback.id,
    label: typeof action.label === "string" ? action.label : fallback.label,
    kind: typeof action.kind === "string"
      ? action.kind as InboxActionKind
      : fallback.kind,
    description: typeof action.description === "string" ? action.description : undefined,
  };
}

function normalizeItem(value: InboxItem): InboxItem {
  const fallbackAction: InboxSuggestedAction = value.category === "read"
    ? { id: "mark-read", label: "Mark read", kind: "mark-read" }
    : { id: "inspect", label: "Open details", kind: "inspect" };
  const briefing = value.briefing ?? {} as InboxBriefing;
  return {
    ...value,
    id: String(value.id),
    cardId: String(value.cardId),
    readAt: value.readAt ? itemTimestamp(value.readAt) : null,
    pinnedAt: value.pinnedAt ? itemTimestamp(value.pinnedAt) : null,
    snoozedUntil: value.snoozedUntil ? itemTimestamp(value.snoozedUntil) : null,
    createdAt: itemTimestamp(value.createdAt),
    updatedAt: itemTimestamp(value.updatedAt),
    priorityReasons: Array.isArray(value.priorityReasons) ? value.priorityReasons : [],
    briefing: {
      message: typeof briefing.message === "string"
        ? briefing.message
        : [
            briefing.recommendationReason,
            briefing.recommendation,
          ].filter(Boolean).join(" "),
      recommendation: typeof briefing.recommendation === "string"
        ? briefing.recommendation
        : "",
      recommendationReason: typeof briefing.recommendationReason === "string"
        ? briefing.recommendationReason
        : "",
      defaultAction: normalizeAction(briefing.defaultAction, fallbackAction),
      alternativeActions: Array.isArray(briefing.alternativeActions)
        ? briefing.alternativeActions.map((action) => normalizeAction(action, fallbackAction))
        : [],
      attention:
        briefing.attention === "now" || briefing.attention === "soon"
          ? briefing.attention
          : "routine",
      synthesisStatus:
        briefing.synthesisStatus === "generated" ||
          briefing.synthesisStatus === "pending"
          ? briefing.synthesisStatus
          : "failed",
      outcome: typeof briefing.outcome === "string" ? briefing.outcome : "",
      trigger: briefing.trigger || value.sourceKind,
      evidenceSummary: briefing.evidenceSummary,
      caveats: Array.isArray(briefing.caveats) ? briefing.caveats : [],
      confidence: briefing.confidence || "medium",
      freshness: {
        sourceRevision: briefing.freshness?.sourceRevision,
        generatedAt: itemTimestamp(briefing.freshness?.generatedAt),
        stale: briefing.freshness?.stale === true,
      },
      provenance: briefing.provenance || "Planwerk",
    },
    evidence: value.evidence ?? {},
  };
}

function sortItems(items: InboxItem[]): InboxItem[] {
  return [...items].sort((a, b) => {
    const pinDelta = Number(Boolean(b.pinnedAt)) - Number(Boolean(a.pinnedAt));
    if (pinDelta !== 0) return pinDelta;
    if (a.priorityBand !== b.priorityBand) return a.priorityBand - b.priorityBand;
    if (a.priorityScore !== b.priorityScore) return b.priorityScore - a.priorityScore;
    return b.updatedAt - a.updatedAt;
  });
}

export function inboxCountsFor(items: InboxItem[]): InboxCounts {
  return {
    priority: items.filter(
      (item) =>
        item.workflowState === "open"
        && (
          item.priorityBand <= 4
          || item.category === "review"
          || (item.category === "read" && item.readAt === null)
        ),
    ).length,
    unread: items.filter((item) => item.workflowState === "open" && item.readAt === null).length,
    open: items.filter((item) => item.workflowState === "open").length,
    snoozed: items.filter((item) => item.workflowState === "snoozed").length,
    done: items.filter(
      (item) => item.workflowState === "resolved" || item.workflowState === "superseded",
    ).length,
  };
}

export function filterInboxItemsByWorkspace(
  items: InboxItem[],
  cards: KanbanCard[],
  workspaceFilters: Set<string>,
): InboxItem[] {
  if (workspaceFilters.size === 0) return items;
  const cardsById = new Map(cards.map((card) => [card.id, card]));
  return items.filter((item) => {
    const project = cardsById.get(item.cardId)?.project;
    return project
      ? workspaceFilters.has(project.path)
      : workspaceFilters.has(UNASSIGNED_WORKSPACE);
  });
}

export function visibleInboxItems(state: Pick<InboxState, "items" | "filter">): InboxItem[] {
  const now = Date.now();
  return state.items.filter((item) => {
    switch (state.filter) {
      case "priority":
        return (
          item.workflowState === "open"
          && (
            item.priorityBand <= 4
            || item.category === "review"
            || (item.category === "read" && item.readAt === null)
          )
        );
      case "unread":
        return item.workflowState === "open" && item.readAt === null;
      case "open":
        return item.workflowState === "open";
      case "snoozed":
        return item.workflowState === "snoozed" && (item.snoozedUntil ?? now) > now;
      case "done":
        return item.workflowState === "resolved" || item.workflowState === "superseded";
    }
  });
}

export const useInboxStore = create<InboxState>()((set, get) => ({
  items: [],
  counts: EMPTY_COUNTS,
  filter: "priority",
  selectedId: null,
  isLoading: false,
  error: null,
  pendingIds: new Set(),

  hydrate: async (hostUrl) => {
    set({ isLoading: true, error: null });
    try {
      const query = hostUrl ? `?host=${encodeURIComponent(hostUrl)}` : "";
      const response = await fetch(`/api/inbox${query}`, { cache: "no-store" });
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: unknown };
        throw new Error(typeof body.error === "string" ? body.error : "Could not load the inbox");
      }
      const body = await response.json() as { items?: InboxItem[]; counts?: InboxCounts };
      const items = sortItems((body.items ?? []).map(normalizeItem));
      const currentSelected = get().selectedId;
      set({
        items,
        counts: body.counts ?? EMPTY_COUNTS,
        selectedId:
          currentSelected && items.some((item) => item.id === currentSelected)
            ? currentSelected
            : items[0]?.id ?? null,
        isLoading: false,
      });
    } catch (error) {
      set({
        isLoading: false,
        error: error instanceof Error ? error.message : "Could not load the inbox",
      });
    }
  },

  setFilter: (filter) => {
    set((state) => {
      const visible = visibleInboxItems({ items: state.items, filter });
      return {
        filter,
        selectedId: visible.some((item) => item.id === state.selectedId)
          ? state.selectedId
          : visible[0]?.id ?? null,
      };
    });
  },

  selectItem: (selectedId) => set({ selectedId }),

  focusCard: (cardId) => {
    const item = get().items.find(
      (candidate) => candidate.cardId === cardId && candidate.workflowState === "open",
    );
    if (!item) return false;
    set({ selectedId: item.id, filter: "open" });
    return true;
  },

  reconcileItem: (item) => {
    const normalized = normalizeItem(item);
    set((state) => {
      const exists = state.items.some((candidate) => candidate.id === normalized.id);
      const items = sortItems(
        exists
          ? state.items.map((candidate) => candidate.id === normalized.id ? normalized : candidate)
          : [...state.items, normalized],
      );
      return {
        items,
        counts: inboxCountsFor(items),
        selectedId: state.selectedId ?? normalized.id,
      };
    });
  },

  removeItem: (id) => {
    set((state) => {
      const items = state.items.filter((item) => item.id !== id);
      return {
        items,
        counts: inboxCountsFor(items),
        selectedId: state.selectedId === id ? items[0]?.id ?? null : state.selectedId,
      };
    });
  },

  mutateItem: async (id, mutation) => {
    const previous = get().items.find((item) => item.id === id);
    if (!previous || get().pendingIds.has(id)) return null;
    set((state) => ({ pendingIds: new Set([...state.pendingIds, id]), error: null }));
    try {
      const response = await fetch(`/api/inbox/${encodeURIComponent(id)}/actions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(mutation),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: unknown };
        throw new Error(typeof body.error === "string" ? body.error : "Inbox action failed");
      }
      const body = await response.json() as { item?: InboxItem };
      if (!body.item) throw new Error("Inbox action returned no item");
      const item = normalizeItem(body.item);
      get().reconcileItem(item);
      const current = get();
      const visible = visibleInboxItems(current);
      if (
        current.selectedId === item.id
        && !visible.some((candidate) => candidate.id === item.id)
      ) {
        set({ selectedId: visible[0]?.id ?? null });
      }
      return item;
    } catch (error) {
      set({ error: error instanceof Error ? error.message : "Inbox action failed" });
      return null;
    } finally {
      set((state) => {
        const pendingIds = new Set(state.pendingIds);
        pendingIds.delete(id);
        return { pendingIds };
      });
    }
  },
}));
