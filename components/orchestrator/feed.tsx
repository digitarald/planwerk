"use client";

import { ScrollArea } from "@/components/ui/scroll-area";
import { FeedItem } from "@/components/orchestrator/feed-item";
import { ChatInput } from "@/components/orchestrator/chat-input";
import { HealthBar } from "@/components/orchestrator/health-bar";
import { Separator } from "@/components/ui/separator";
import { useBoardStore } from "@/lib/store/board-store";
import { useOrchestratorStore } from "@/lib/store/orchestrator-store";
import { Zap } from "lucide-react";

export function OrchestratorFeed() {
  const feedItems = useOrchestratorStore((s) => s.feedItems);
  const cards = useBoardStore((s) => s.cards);

  const active = cards.filter((c) => c.runtime === "running").length;
  const idle = cards.filter((c) => c.runtime === "idle").length;
  const errors = cards.filter((c) => c.runtime === "error").length;
  const needsInput = cards.filter((c) => c.runtime === "input-needed").length;

  return (
    <div className="flex flex-col h-full">
      <div className="p-3 flex items-center gap-2">
        <Zap className="h-3.5 w-3.5 text-primary" />
        <span className="text-xs font-medium">
          {cards.length > 0
            ? `Active · ${cards.length} sessions`
            : "Waiting for sessions..."}
        </span>
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
