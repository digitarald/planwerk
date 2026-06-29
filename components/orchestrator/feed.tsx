"use client";

import { ScrollArea } from "@/components/ui/scroll-area";
import { FeedItem } from "@/components/orchestrator/feed-item";
import { ChatInput } from "@/components/orchestrator/chat-input";
import { HealthBar } from "@/components/orchestrator/health-bar";
import { ConnectionDot } from "@/components/connection/connection-dot";
import { Separator } from "@/components/ui/separator";
import { useShallow } from "zustand/react/shallow";
import { useBoardStore, selectSessionCounts } from "@/lib/store/board-store";
import { useOrchestratorStore } from "@/lib/store/orchestrator-store";
import { Zap } from "lucide-react";

export function OrchestratorFeed() {
  const feedItems = useOrchestratorStore((s) => s.feedItems);
  const monitoringStatus = useOrchestratorStore((s) => s.monitoringStatus);
  const { total, active, idle, errors, needsInput } = useBoardStore(
    useShallow(selectSessionCounts)
  );

  return (
    <div className="flex flex-col h-full">
      <div className="p-3 space-y-1.5">
        <div className="flex items-center gap-2">
          <Zap className="h-3.5 w-3.5 text-primary" />
          <span className="text-xs font-medium">
            {total > 0
              ? `${total} session${total === 1 ? "" : "s"}`
              : "Waiting for sessions..."}
          </span>
        </div>
        {/* Pinned instrument readout — connection + monitoring status, kept
            out of the conversational feed below. */}
        <div className="flex items-center gap-2">
          <ConnectionDot />
          {monitoringStatus && (
            <span className="text-[11px] text-muted-foreground/80">
              · {monitoringStatus.reconnected ? "reconnected · " : ""}
              monitoring {monitoringStatus.sessionCount} session
              {monitoringStatus.sessionCount === 1 ? "" : "s"}
            </span>
          )}
        </div>
      </div>

      <Separator />

      <ScrollArea className="flex-1 min-h-0">
        <div className="p-3 space-y-3 flex flex-col-reverse">
          {feedItems.length === 0 ? (
            <p className="text-xs text-muted-foreground text-center py-4">
              No activity yet. Connect to an AHP host to begin.
            </p>
          ) : (
            feedItems.map((item) => <FeedItem key={item.id} {...item} />)
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
