import type {
  InboxApiActionKind,
  InboxActionResponse,
  InboxApiItem,
  InboxApiSuggestedAction,
  InboxCategory,
  InboxCounts,
  InboxItem,
  InboxItemKind,
  InboxListResponse,
} from "./types.ts";
import { inboxSourceFreshness } from "./freshness.ts";

const BAND_NUMBER = {
  urgent: 1,
  high: 3,
  normal: 5,
  low: 7,
} as const;

const ACTIONABLE_KINDS = new Set<InboxItemKind>([
  "pending-input",
  "runtime-error",
  "review-ready",
  "ship-ready",
  "gate-failure",
  "review-escalation",
  "conflict",
]);

function timestamp(value: string | null): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function categoryFor(kind: InboxItemKind): InboxCategory {
  if (kind === "review-ready" || kind === "ship-ready") return "review";
  if (kind === "completion" || kind === "coordinator-action") return "read";
  return "action";
}

function actionKind(id: string, kind: InboxItemKind): InboxApiActionKind {
  if (id.includes("resolve") || id.includes("dismiss")) return "resolve";
  if (id.includes("reply") || kind === "pending-input") return "reply";
  if (id.includes("review") || kind === "review-ready") return "review";
  if (id.includes("session")) return "open-session";
  return "inspect";
}

function suggestedAction(
  id: string,
  label: string,
  kind: InboxItemKind,
  description?: string,
  intent?: InboxApiActionKind,
): InboxApiSuggestedAction {
  return {
    id,
    label,
    kind: intent ?? actionKind(id, kind),
    description,
  };
}

function defaultAction(item: InboxItem): InboxApiSuggestedAction {
  if (item.briefing.recommendedAction) {
    const action = item.briefing.recommendedAction;
    return suggestedAction(
      action.id,
      action.label,
      item.kind,
      action.description,
      action.intent,
    );
  }
  switch (item.kind) {
    case "pending-input":
      return suggestedAction(
        "reply",
        "Reply",
        item.kind,
        "Open the session and answer the pending request.",
      );
    case "review-ready":
      return suggestedAction("review", "Review", item.kind);
    case "ship-ready":
      return suggestedAction("inspect", "Review", item.kind);
    case "completion":
      return suggestedAction("inspect", "Read", item.kind);
    case "coordinator-action":
      return {
        id: "mark-read",
        label: "Read",
        kind: "mark-read",
      };
    default:
      return suggestedAction("inspect", "Inspect", item.kind);
  }
}

function isStale(item: InboxItem, sourceObservedAt: number | undefined, now: number): boolean {
  if (
    item.workflowState !== "open" ||
    !ACTIONABLE_KINDS.has(item.kind)
  ) {
    return false;
  }
  return inboxSourceFreshness(sourceObservedAt, true, now) !== "current";
}

export function serializeInboxItem(
  item: InboxItem,
  now = Date.now(),
): InboxApiItem {
  const generatedAt =
    timestamp(item.briefing.synthesis?.generatedAt ?? null)
      ?? timestamp(item.briefing.freshness.observedAt) ?? timestamp(item.updatedAt) ??
      now;
  const sourceObservedAt = timestamp(item.briefing.freshness.sourceObservedAt ?? null) ?? undefined;
  const snoozedUntil = timestamp(item.snoozedUntil);
  const workflowState = item.workflowState === "dismissed"
    ? snoozedUntil
      ? "snoozed"
      : "superseded"
    : item.workflowState;
  const alternatives = item.briefing.alternativeActions.map((action) =>
    suggestedAction(
      action.id,
      action.label,
      item.kind,
      action.description,
      action.intent,
    )
  );
  const provenance = item.briefing.provenance;
  const attention = item.briefing.synthesis?.attention ?? "routine";
  const attentionBoost = attention === "now"
    ? 20
    : attention === "soon"
      ? 10
      : 0;
  const synthesisStatus = item.briefing.synthesis?.status ?? "failed";
  const baseBand = BAND_NUMBER[item.priorityBand];
  const effectiveBand = Math.max(
    1,
    baseBand + (attention === "now" ? -1 : attention === "routine" ? 1 : 0),
  );

  return {
    id: item.id,
    cardId: item.cardId ?? "",
    sourceKind: item.kind,
    category: categoryFor(item.kind),
    workflowState,
    readAt: timestamp(item.readAt),
    pinnedAt: timestamp(item.pinnedAt),
    snoozedUntil,
    priorityBand: effectiveBand,
    priorityScore: item.priorityRank + attentionBoost,
    priorityReasons: [
      ...(attention === "routine"
        ? []
        : [`Chief of Staff: ${attention}`]),
      item.briefing.reason,
      `${item.priorityBand} priority ${item.kind}`,
    ],
    title: item.title,
    sessionTitle: provenance.sessionTitle,
    projectName: provenance.projectName,
    workspacePath: provenance.workspacePath,
    briefing: {
      message: item.briefing.message ?? [
        item.briefing.reason,
        item.briefing.recommendation,
      ].filter(Boolean).join(" "),
      recommendation: item.briefing.recommendation,
      recommendationReason: item.briefing.reason,
      defaultAction: defaultAction(item),
      alternativeActions: alternatives,
      attention,
      synthesisStatus,
      outcome: item.briefing.outcome,
      trigger: provenance.eventType,
      evidenceSummary: item.briefing.reason,
      caveats: item.briefing.caveats,
      confidence: item.briefing.confidence,
      freshness: {
        sourceRevision: item.sourceRevision,
        generatedAt,
        sourceObservedAt,
        stale: isStale(item, sourceObservedAt, now),
      },
      provenance: [
        provenance.sourceType,
        provenance.eventType,
        provenance.sourceKey,
      ].join(" · "),
    },
    evidence: {
      provenance,
      relatedCardIds: item.relatedCardIds,
      sourceRevision: item.sourceRevision,
    },
    createdAt: timestamp(item.createdAt) ?? now,
    updatedAt: timestamp(item.updatedAt) ?? now,
  };
}

export function serializeInboxListResponse(
  items: InboxItem[],
  counts: InboxCounts,
): InboxListResponse {
  return {
    items: items.map((item) => serializeInboxItem(item)),
    counts,
  };
}

export function serializeInboxActionResponse(
  item: InboxItem,
): InboxActionResponse {
  return { item: serializeInboxItem(item) };
}

export function inboxItemMatchesHost(
  item: InboxItem,
  expectedHostUrl: string | undefined,
): boolean {
  return expectedHostUrl === undefined ||
    item.briefing.provenance.hostUrl === expectedHostUrl;
}
