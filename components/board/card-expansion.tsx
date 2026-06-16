"use client";

import { useState } from "react";
import { Send, FileCode, GitBranch, Cpu, ChevronDown, ChevronRight, X } from "lucide-react";

import { GatePipeline } from "@/components/gates/gate-pipeline";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { useBoardStore } from "@/lib/store/board-store";
import { useOrchestratorStore } from "@/lib/store/orchestrator-store";
import { KanbanCard as KanbanCardType } from "@/lib/types";

interface CardExpansionProps {
  card: KanbanCardType;
}

export function CardExpansion({ card }: CardExpansionProps) {
  const [message, setMessage] = useState("");
  const [showFiles, setShowFiles] = useState(false);
  const setExpandedCard = useBoardStore((s) => s.setExpandedCard);
  const addFeedItem = useOrchestratorStore((s) => s.addFeedItem);

  const handleInject = (e: React.FormEvent) => {
    e.preventDefault();
    if (!message.trim()) return;
    addFeedItem({
      type: "intervention",
      message: `Message sent to "${card.title}": "${message.trim()}"`,
      cardId: card.id,
    });
    setMessage("");
  };

  return (
    <div className="mt-2 space-y-2.5 border-t border-border pt-2 animate-in fade-in slide-in-from-top-1 duration-200">
      <GatePipeline
        cardId={card.id}
        currentPhase={card.phase}
        gateStatus={card.gateStatus}
        runtime={card.runtime}
      />

      {card.planSteps.total > 0 && (
        <div className="space-y-1">
          <div className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
            Plan Progress
          </div>
          <div className="flex items-center gap-2">
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-primary transition-all"
                style={{ width: `${(card.planSteps.done / card.planSteps.total) * 100}%` }}
              />
            </div>
            <span className="text-[11px] font-medium text-muted-foreground">
              {card.planSteps.done}/{card.planSteps.total} steps
            </span>
          </div>
        </div>
      )}

      {card.filesChanged > 0 && (
        <div>
          <button
            onClick={(e) => {
              e.stopPropagation();
              setShowFiles(!showFiles);
            }}
            className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground"
          >
            {showFiles ? (
              <ChevronDown className="h-3 w-3" />
            ) : (
              <ChevronRight className="h-3 w-3" />
            )}
            <FileCode className="h-3 w-3" />
            <span>{card.filesChanged} files</span>
            <span className="text-emerald-600">+{card.additions}</span>
            <span className="text-red-600">-{card.deletions}</span>
          </button>
          {showFiles && (
            <div className="mt-1 space-y-0.5 pl-4 font-mono text-[10px] text-muted-foreground">
              <div>src/auth/middleware.ts</div>
              <div>src/auth/refresh.ts</div>
              <div>tests/auth.test.ts</div>
            </div>
          )}
        </div>
      )}

      <div className="flex flex-wrap gap-1.5">
        {card.model && (
          <Badge variant="secondary" className="h-4 gap-1 px-1.5 text-[10px]">
            <Cpu className="h-2.5 w-2.5" />
            {card.model}
          </Badge>
        )}
        {card.branch && (
          <Badge variant="secondary" className="h-4 gap-1 px-1.5 text-[10px]">
            <GitBranch className="h-2.5 w-2.5" />
            {card.branch}
          </Badge>
        )}
      </div>

      <Separator />

      <form onSubmit={handleInject} className="flex gap-1.5">
        <Input
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onClick={(e) => e.stopPropagation()}
          placeholder="Send message to session..."
          className="h-7 flex-1 text-[11px]"
        />
        <Button
          type="submit"
          size="sm"
          variant="ghost"
          disabled={!message.trim()}
          className="h-7 w-7 p-0"
          onClick={(e) => e.stopPropagation()}
        >
          <Send className="h-3 w-3" />
        </Button>
      </form>

      <div className="flex justify-end">
        <Button
          size="sm"
          variant="ghost"
          className="h-5 px-1.5 text-[10px] text-muted-foreground"
          onClick={(e) => {
            e.stopPropagation();
            setExpandedCard(null);
          }}
        >
          <X className="mr-0.5 h-3 w-3" /> Close
        </Button>
      </div>
    </div>
  );
}
