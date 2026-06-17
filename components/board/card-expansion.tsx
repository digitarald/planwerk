"use client";

import { useState } from "react";
import {
  Send,
  FileCode,
  GitBranch,
  FileText,
  FlaskConical,
  Lightbulb,
  BookOpen,
  ClipboardCheck,
  Scale,
  Wrench,
  Bot,
  Shield,
} from "lucide-react";

import { ArtifactViewer } from "./artifact-viewer";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { useOrchestratorStore } from "@/lib/store/orchestrator-store";
import {
  KanbanCard as KanbanCardType,
  Artifact,
  ArtifactType,
  ArtifactStatus,
  ActivityEntry,
} from "@/lib/types";

interface CardExpansionProps {
  card: KanbanCardType;
}

const artifactIcons: Record<ArtifactType, typeof FileText> = {
  plan: FileText,
  research: FlaskConical,
  design: Lightbulb,
  spec: BookOpen,
  "test-plan": ClipboardCheck,
  decision: Scale,
};

const artifactStatusColors: Record<ArtifactStatus, string> = {
  draft: "text-muted-foreground",
  approved: "text-emerald-600",
  superseded: "text-muted-foreground/40 line-through",
};

const activityIcons: Record<ActivityEntry["type"], typeof Wrench> = {
  tool: Wrench,
  agent: Bot,
  gate: Shield,
};

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function CardExpansion({ card }: CardExpansionProps) {
  const [message, setMessage] = useState("");
  const [isMessageFocused, setIsMessageFocused] = useState(false);
  const [viewingArtifact, setViewingArtifact] = useState<Artifact | null>(null);
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

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleInject(e);
    }
  };

  const artifacts = card.artifacts ?? [];
  const recentActivity = card.recentActivity ?? [];

  return (
    <div
      className="mt-2 space-y-2 border-t border-border/60 pt-2 animate-in fade-in slide-in-from-top-1 duration-200 ease-out"
      onClick={(e) => e.stopPropagation()}
    >
      {/* Artifacts */}
      {artifacts.length > 0 && (
        <div className="space-y-1">
          <div className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
            Artifacts
          </div>
          <div className="space-y-0.5">
            {artifacts.map((artifact) => {
              const Icon = artifactIcons[artifact.type];
              const hasContent = !!artifact.contentRef;
              return (
                <button
                  key={artifact.id}
                  type="button"
                  aria-disabled={!hasContent}
                  tabIndex={hasContent ? 0 : -1}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (hasContent) setViewingArtifact(artifact);
                  }}
                  onKeyDown={(e) => e.stopPropagation()}
                  onPointerDown={(e) => e.stopPropagation()}
                  className={`flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-[11px] text-left transition-colors ${
                    hasContent
                      ? "hover:bg-muted/50 cursor-pointer"
                      : "opacity-60 cursor-default"
                  }`}
                >
                  <Icon className="h-3 w-3 shrink-0 text-muted-foreground" />
                  <span
                    className={`min-w-0 flex-1 truncate ${artifactStatusColors[artifact.status]}`}
                  >
                    {artifact.title}
                  </span>
                  <span className="shrink-0 text-[9px] capitalize text-muted-foreground/50">
                    {artifact.status}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      <ArtifactViewer
        artifact={viewingArtifact}
        open={viewingArtifact !== null}
        onOpenChange={(open) => {
          if (!open) setViewingArtifact(null);
        }}
      />

      {/* Recent Activity */}
      {recentActivity.length > 0 && (
        <div className="space-y-1">
          <div className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
            Recent
          </div>
          <div className="space-y-0.5">
            {recentActivity.slice(0, 3).map((entry, idx) => {
              const Icon = activityIcons[entry.type];
              return (
                <div
                  key={idx}
                  className="flex items-start gap-1.5 text-[10px] text-muted-foreground"
                >
                  <Icon className="mt-0.5 h-2.5 w-2.5 shrink-0" />
                  <span className="min-w-0 flex-1 line-clamp-1">
                    {entry.message}
                  </span>
                  <span className="shrink-0 tabular-nums text-muted-foreground/50">
                    {formatTime(entry.timestamp)}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Files */}
      {card.filesChanged > 0 && (
        <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
          <FileCode className="h-3 w-3" />
          <span>{card.filesChanged} files</span>
          <span className="text-emerald-600">+{card.additions}</span>
          <span className="text-red-600">-{card.deletions}</span>
        </div>
      )}

      {/* Branch */}
      {card.branch && (
        <Badge variant="secondary" className="h-4 gap-1 px-1.5 text-[10px]">
          <GitBranch className="h-2.5 w-2.5" />
          {card.branch}
        </Badge>
      )}

      <Separator />

      {/* Chat input — textarea with embedded send button */}
      <form onSubmit={handleInject} className="relative">
        <Textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={handleKeyDown}
          onFocus={() => setIsMessageFocused(true)}
          onBlur={() => setIsMessageFocused(false)}
          onClick={(e) => e.stopPropagation()}
          placeholder="Send message to session..."
          className="min-h-[2rem] resize-none pr-8 text-[11px] transition-all duration-200 focus:min-h-[3.5rem]"
          rows={isMessageFocused ? 2 : 1}
        />
        <Button
          type="submit"
          size="sm"
          variant="ghost"
          disabled={!message.trim()}
          className="absolute bottom-1.5 right-1.5 h-6 w-6 p-0"
          onClick={(e) => e.stopPropagation()}
        >
          <Send className="h-3 w-3" />
        </Button>
      </form>
    </div>
  );
}
