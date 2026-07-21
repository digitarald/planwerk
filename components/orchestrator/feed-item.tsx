"use client";

import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  Lightbulb,
  RefreshCw,
  Shield,
  User,
  Wrench,
  Zap,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useBoardStore } from "@/lib/store/board-store";
import type { KanbanCard } from "@/lib/types";

type FeedItemType =
  | "intervention"
  | "alert"
  | "transition"
  | "suggestion"
  | "triage"
  | "user"
  | "response"
  | "heartbeat"
  | "tool-action";

interface FeedItemProps {
  id: string;
  type: FeedItemType;
  message: string;
  timestamp: number;
  cardId?: string;
  cardTitle?: string;
  projectName?: string;
  isStreaming?: boolean;
  toolName?: string;
}

const typeConfig: Record<FeedItemType, { icon: typeof RefreshCw; color: string; label: string }> = {
  intervention: { icon: Zap, color: "text-primary", label: "Intervention" },
  alert: { icon: AlertTriangle, color: "text-amber-600", label: "Alert" },
  transition: { icon: CheckCircle2, color: "text-muted-foreground", label: "Transition" },
  suggestion: { icon: Lightbulb, color: "text-muted-foreground", label: "Suggestion" },
  triage: { icon: Shield, color: "text-muted-foreground", label: "Triage" },
  user: { icon: User, color: "text-muted-foreground", label: "You" },
  response: { icon: Bot, color: "text-muted-foreground", label: "Orchestrator" },
  heartbeat: { icon: RefreshCw, color: "text-muted-foreground/70", label: "Heartbeat" },
  "tool-action": { icon: Wrench, color: "text-muted-foreground", label: "Tool action" },
};

function formatRelativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return "now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function CardLink({ cardId, title }: { cardId: string; title: string }) {
  const setDetailCard = useBoardStore((s) => s.setDetailCard);

  return (
    <button
      onClick={() => setDetailCard(cardId)}
      className="min-w-0 truncate text-left text-[11px] font-medium text-foreground transition-colors hover:text-primary hover:underline underline-offset-2"
      title={title}
    >
      {title}
    </button>
  );
}

function InlinePendingInput({ card }: { card: KanbanCard }) {
  const setDetailCard = useBoardStore((s) => s.setDetailCard);
  const input = card.pendingInput;
  if (!input) return null;

  const question = input.questions[0];
  const supportedKinds = ["single-select", "boolean"];
  const isQuickActionable =
    input.questions.length <= 1 &&
    question &&
    supportedKinds.includes(question.kind);

  if (isQuickActionable && question.kind === "single-select" && question.options) {
    return (
      <div className="mt-1.5 space-y-1.5">
        {question.message && (
          <p className="text-[10px] text-muted-foreground leading-snug">{question.message}</p>
        )}
        <div className="flex flex-wrap gap-1">
          {question.options.slice(0, 4).map((opt) => (
            <button
              key={opt.id}
              onClick={() => setDetailCard(card.id)}
              className={cn(
                "inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-medium border shadow-sm transition-all duration-150",
                opt.recommended
                  ? "border-primary/40 bg-primary text-primary-foreground hover:bg-primary/90"
                  : "border-border bg-background text-foreground hover:border-primary/30 hover:bg-primary/5"
              )}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>
    );
  }

  // Fallback: show message + open-on-board link
  return (
    <div className="mt-1.5">
      {(input.message || question?.message) && (
        <p className="text-[10px] text-muted-foreground leading-snug mb-1">
          {input.message || question?.message}
        </p>
      )}
      <button
        onClick={() => setDetailCard(card.id)}
        className="inline-flex items-center gap-1 text-[10px] font-medium text-primary hover:underline underline-offset-2"
      >
        Open on board
      </button>
    </div>
  );
}

export function FeedItem({
  type,
  message,
  timestamp,
  cardId,
  cardTitle,
  projectName,
  isStreaming,
  toolName,
}: FeedItemProps) {
  const config = typeConfig[type];
  const Icon = config.icon;
  const card = useBoardStore((s) => (cardId ? s.getCard(cardId) : undefined));

  const showInlineInput = type === "alert" && card?.pendingInput;
  const resolvedProjectName = projectName ?? card?.project?.name;
  const resolvedCardTitle = cardTitle ?? card?.title;

  return (
    <div
      className={cn(
        "flex gap-2 border-b border-border/60 py-2 text-xs last:border-b-0",
        "animate-in fade-in duration-150 motion-reduce:animate-none",
      )}
    >
      <Icon
        aria-label={config.label}
        className={cn("mt-0.5 h-3 w-3 shrink-0", config.color)}
      />
      <div className="flex-1 min-w-0">
        <div className="flex min-w-0 items-center gap-1.5 text-[10px] leading-4 text-muted-foreground">
          <time
            dateTime={new Date(timestamp).toISOString()}
            title={new Date(timestamp).toLocaleString()}
            className="shrink-0 tabular-nums"
          >
            {formatRelativeTime(timestamp)}
          </time>
          {resolvedProjectName && (
            <>
              <span aria-hidden="true" className="text-border">/</span>
              <span className="max-w-20 shrink-0 truncate" title={resolvedProjectName}>
                {resolvedProjectName}
              </span>
            </>
          )}
          {cardId && resolvedCardTitle && (
            <>
              <span aria-hidden="true" className="text-border">/</span>
              <CardLink cardId={cardId} title={resolvedCardTitle} />
            </>
          )}
          {toolName && (
            <span className="truncate font-mono" title={toolName}>
              {toolName}
            </span>
          )}
        </div>
        <p
          className={cn(
            "mt-0.5 text-[11px] leading-4 text-muted-foreground",
            type === "alert" && "text-foreground",
            isStreaming && "after:ml-0.5 after:animate-pulse after:text-primary after:content-['▊']",
          )}
        >
          {message || (isStreaming ? "Thinking..." : "")}
        </p>

        {showInlineInput && card && <InlinePendingInput card={card} />}
      </div>
    </div>
  );
}
