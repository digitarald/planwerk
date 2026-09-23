"use client";

import { useMemo } from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { FeedItem } from "@/components/orchestrator/feed-item";
import { ChatInput } from "@/components/orchestrator/chat-input";
import { HealthBar } from "@/components/orchestrator/health-bar";
import { BoardCoordinatorModeControl } from "@/components/orchestrator/coordinator-mode-control";
import { ConnectionDot } from "@/components/connection/connection-dot";
import { Separator } from "@/components/ui/separator";
import { useShallow } from "zustand/react/shallow";
import { useBoardStore, selectSessionCounts } from "@/lib/store/board-store";
import { useOrchestratorStore } from "@/lib/store/orchestrator-store";
import { groupDuplicateFeedItems } from "@/lib/orchestrator/feed-grouping";
import { Activity, Trash2 } from "lucide-react";

export function OrchestratorFeed() {
  const feedItems = useOrchestratorStore((s) => s.feedItems);
  const monitoringStatus = useOrchestratorStore((s) => s.monitoringStatus);
  const clearFeed = useOrchestratorStore((s) => s.clearFeed);
  const cards = useBoardStore((s) => s.cards);
  const { total, active, idle, errors, needsInput } = useBoardStore(
    useShallow(selectSessionCounts)
  );
  const groupedFeedItems = useMemo(() => {
    const interactiveCards = new Set(
      cards.flatMap((card) => card.pendingInput ? [card.id] : []),
    );
    return groupDuplicateFeedItems(
      feedItems,
      (item) => Boolean(item.cardId && interactiveCards.has(item.cardId)),
    );
  }, [cards, feedItems]);
  const hasClearableItems = feedItems.some(
    (item) => !item.isStreaming && !item.approval && !item.decisionPending
  );

  return (
    <div className="flex flex-col h-full">
      <div className="space-y-1 px-3 pb-2 pt-1">
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-1.5">
            <Activity className="h-3 w-3 shrink-0 text-muted-foreground" />
            <span className="truncate text-[11px] font-medium text-foreground">
              {total > 0
                ? `${total} session${total === 1 ? "" : "s"}`
                : "No sessions"}
            </span>
          </div>
          {hasClearableItems && (
            <button
              type="button"
              onClick={clearFeed}
              className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              aria-label="Clear activity"
              title="Clear activity"
            >
              <Trash2 className="h-3 w-3" />
            </button>
          )}
        </div>
        {/* Pinned instrument readout — connection + monitoring status, kept
            out of the conversational feed below. */}
        <div className="flex items-center gap-1.5 pl-0.5">
          <ConnectionDot />
          {monitoringStatus && (
            <span className="text-[10px] text-muted-foreground">
              · {monitoringStatus.reconnected ? "reconnected · " : ""}
              monitoring {monitoringStatus.sessionCount} session
              {monitoringStatus.sessionCount === 1 ? "" : "s"}
            </span>
          )}
        </div>
        <BoardCoordinatorModeControl />
      </div>

      <Separator />

      <ScrollArea className="flex-1 min-h-0">
        <div className="flex flex-col-reverse px-3">
          {feedItems.length === 0 ? (
            <p className="py-4 text-center text-[11px] text-muted-foreground">
              {total > 0
                ? "No recent activity."
                : "Connect to VS Code to see activity."}
            </p>
          ) : (
            groupedFeedItems.map((item) => (
              <FeedItem key={item.id} {...item} />
            ))
          )}
        </div>
      </ScrollArea>

      <Separator />

      <HealthBar
        active={active}
        idle={idle}
        errors={errors}
        needsInput={needsInput}
      />

      <Separator />

      <ChatInput />
    </div>
  );
}
