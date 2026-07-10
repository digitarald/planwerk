import { AlertCircle, Clock, MessageCircleWarning, Split, XCircle, type LucideIcon } from "lucide-react";

import type { AttentionLevel, KanbanCard } from "@/lib/types";

/** Severity ordering for attention. Higher wins when a group of cards is
 *  summarized to a single indicator (column header, title bar). `none` is 0 so
 *  a healthy card never outranks one that needs a human. */
export const ATTENTION_PRIORITY: Record<AttentionLevel, number> = {
  none: 0,
  stale: 1,
  "needs-human": 2,
  conflict: 3,
  error: 4,
};

export type ActiveAttention = Exclude<AttentionLevel, "none">;

/** Visual + semantic metadata for each attention level that needs a human.
 *  Shared so the card, column header, and title bar speak one vocabulary. */
export const ATTENTION_META: Record<
  ActiveAttention,
  { rank: number; Icon: LucideIcon; label: string; pill: string; text: string }
> = {
  error: {
    rank: ATTENTION_PRIORITY.error,
    Icon: XCircle,
    label: "error",
    pill: "bg-red-500 text-white dark:bg-red-500",
    text: "text-red-600 dark:text-red-400",
  },
  conflict: {
    rank: ATTENTION_PRIORITY.conflict,
    Icon: Split,
    label: "conflict",
    pill: "bg-purple-500 text-white dark:bg-purple-500",
    text: "text-purple-600 dark:text-purple-400",
  },
  "needs-human": {
    rank: ATTENTION_PRIORITY["needs-human"],
    Icon: MessageCircleWarning,
    label: "needs input",
    pill: "bg-amber-500 text-white dark:bg-amber-500",
    text: "text-amber-700 dark:text-amber-400",
  },
  stale: {
    rank: ATTENTION_PRIORITY.stale,
    Icon: Clock,
    label: "stale",
    pill: "bg-muted text-muted-foreground",
    text: "text-muted-foreground",
  },
};

/** Fallback icon for a summarized attention indicator when the level is unknown. */
export const AttentionFallbackIcon = AlertCircle;

/** The most severe attention level present across a set of cards. Returns
 *  `"none"` when nothing needs a human. */
export function highestAttention(cards: readonly KanbanCard[]): AttentionLevel {
  let top: AttentionLevel = "none";
  for (const card of cards) {
    if (ATTENTION_PRIORITY[card.attention] > ATTENTION_PRIORITY[top]) {
      top = card.attention;
    }
  }
  return top;
}
