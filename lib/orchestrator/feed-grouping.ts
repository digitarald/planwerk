import type { FeedItem } from "../store/orchestrator-store.ts";

export interface GroupedFeedItem extends FeedItem {
  duplicateCount: number;
  duplicateContexts: string[];
}

const GROUPABLE_TYPES = new Set<FeedItem["type"]>([
  "alert",
  "heartbeat",
  "suggestion",
  "triage",
  "transition",
]);

function itemContext(item: FeedItem): string | null {
  if (!item.cardTitle) return null;
  return item.projectName
    ? `${item.cardTitle} · ${item.projectName}`
    : item.cardTitle;
}

export function groupDuplicateFeedItems(
  items: readonly FeedItem[],
  isInteractive: (item: FeedItem) => boolean = () => false,
): GroupedFeedItem[] {
  const grouped: GroupedFeedItem[] = [];
  const byKey = new Map<string, GroupedFeedItem>();

  for (const item of items) {
    const groupable =
      GROUPABLE_TYPES.has(item.type)
      && !item.isStreaming
      && !item.approval
      && !item.decisionPending
      && !isInteractive(item);
    const key = groupable ? `${item.type}\u0000${item.message}` : null;
    const existing = key ? byKey.get(key) : undefined;

    if (!existing) {
      const context = itemContext(item);
      const next = {
        ...item,
        duplicateCount: 0,
        duplicateContexts: context ? [context] : [],
      };
      grouped.push(next);
      if (key) byKey.set(key, next);
      continue;
    }

    existing.duplicateCount += 1;
    const context = itemContext(item);
    if (context && !existing.duplicateContexts.includes(context)) {
      existing.duplicateContexts.push(context);
    }
  }

  return grouped;
}
