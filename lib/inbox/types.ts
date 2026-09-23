export const INBOX_ITEM_KINDS = [
  "pending-input",
  "runtime-error",
  "completion",
  "review-ready",
  "ship-ready",
  "gate-failure",
  "review-escalation",
  "conflict",
  "coordinator-action",
] as const;

export type InboxItemKind = (typeof INBOX_ITEM_KINDS)[number];
export type InboxPriorityBand = "urgent" | "high" | "normal" | "low";
export type InboxWorkflowState = "open" | "resolved" | "dismissed";
export type InboxReadState = "unread" | "read";
export type InboxConfidence = "high" | "medium" | "low";
export type InboxAttention = "now" | "soon" | "routine";
export type InboxActionIntent =
  | "mark-read"
  | "review"
  | "reply"
  | "approve"
  | "inspect"
  | "open-session"
  | "resolve";

export interface InboxAlternativeAction {
  id: string;
  label: string;
  description?: string;
  intent?: InboxActionIntent;
}

export interface InboxFreshness {
  observedAt: string;
  sourceModifiedAt?: string;
}

export interface InboxProvenance {
  sourceType: "ahp-session" | "orchestrator";
  sourceKey: string;
  eventType: string;
  hostUrl?: string;
  cardId?: string;
  relatedCardIds?: string[];
  sourceRevision?: string;
}

export interface InboxBriefing {
  message?: string;
  recommendation: string;
  reason: string;
  recommendedAction?: InboxAlternativeAction;
  alternativeActions: InboxAlternativeAction[];
  outcome: string;
  caveats: string[];
  confidence: InboxConfidence;
  synthesis?: {
    status: "pending" | "generated" | "failed";
    attention?: InboxAttention;
    requestId?: string;
    version?: string;
    model?: string;
    generatedAt?: string;
  };
  freshness: InboxFreshness;
  provenance: InboxProvenance;
}

export interface InboxItem {
  id: string;
  sourceKey: string;
  sourceRevision: string;
  kind: InboxItemKind;
  priorityBand: InboxPriorityBand;
  priorityRank: number;
  workflowState: InboxWorkflowState;
  readState: InboxReadState;
  cardId: string | null;
  relatedCardIds: string[];
  title: string;
  briefing: InboxBriefing;
  createdAt: string;
  updatedAt: string;
  readAt: string | null;
  resolvedAt: string | null;
  pinnedAt: string | null;
  snoozedUntil: string | null;
}

export const INBOX_ACTION_TYPES = [
  "read",
  "unread",
  "resolve",
  "snooze",
  "unsnooze",
  "pin",
  "unpin",
] as const;

export type InboxActionType = (typeof INBOX_ACTION_TYPES)[number];

export interface InboxItemAction {
  id: number;
  inboxItemId: string;
  actionType: InboxActionType;
  actor: "local-human";
  note: string | null;
  previousWorkflowState: InboxWorkflowState;
  nextWorkflowState: InboxWorkflowState;
  previousReadState: InboxReadState;
  nextReadState: InboxReadState;
  snoozedUntil: string | null;
  createdAt: string;
}

export interface InboxItemDraft {
  sourceKey: string;
  sourceRevision: string;
  kind: InboxItemKind;
  cardId?: string;
  relatedCardIds?: string[];
  title: string;
  briefing: InboxBriefing;
}

export type InboxProjectionOperation =
  | { type: "upsert"; item: InboxItemDraft }
  | { type: "resolve-source"; sourceKey: string }
  | {
      type: "resolve-kind";
      kind: InboxItemKind;
      cardId: string | null;
      exceptSourceKey?: string;
    };

export type InboxCategory = "action" | "review" | "read";
export type InboxApiWorkflowState =
  | "open"
  | "resolved"
  | "snoozed"
  | "superseded";
export type InboxApiActionKind = InboxActionIntent;

export interface InboxApiSuggestedAction extends InboxAlternativeAction {
  kind: InboxApiActionKind;
}

export interface InboxApiItem {
  id: string;
  cardId: string;
  sourceKind: InboxItemKind;
  category: InboxCategory;
  workflowState: InboxApiWorkflowState;
  readAt: number | null;
  pinnedAt: number | null;
  snoozedUntil: number | null;
  priorityBand: number;
  priorityScore: number;
  priorityReasons: string[];
  title: string;
  projectName?: string;
  briefing: {
    message: string;
    recommendation: string;
    recommendationReason: string;
    defaultAction: InboxApiSuggestedAction;
    alternativeActions: InboxApiSuggestedAction[];
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
  };
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

export interface InboxListResponse {
  items: InboxApiItem[];
  counts: InboxCounts;
}

export interface InboxActionResponse {
  item: InboxApiItem;
}

export type InboxStreamEvent =
  | { type: "inboxAdded"; item: InboxApiItem; hostUrl?: string }
  | { type: "inboxChanged"; item: InboxApiItem; hostUrl?: string }
  | {
      type: "inboxRemoved";
      itemId: string;
      workflowState: Exclude<InboxWorkflowState, "open">;
      hostUrl?: string;
    };

export interface InboxListQuery {
  workflowState?: InboxWorkflowState | "all";
  readState?: InboxReadState | "all";
  kind?: InboxItemKind;
  cardId?: string;
  hostUrl?: string;
  limit?: number;
}

export interface InboxListResult {
  items: InboxItem[];
  total: number;
}
