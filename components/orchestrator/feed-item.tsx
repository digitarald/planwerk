"use client";

import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  ExternalLink,
  Lightbulb,
  RefreshCw,
  Shield,
  User,
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
  | "response";

interface FeedItemProps {
  id: string;
  type: FeedItemType;
  message: string;
  timestamp: number;
  cardId?: string;
  cardTitle?: string;
}

const typeConfig: Record<FeedItemType, { icon: typeof RefreshCw; color: string }> = {
  intervention: { icon: RefreshCw, color: "text-primary" },
  alert: { icon: AlertTriangle, color: "text-amber-600" },
  transition: { icon: CheckCircle2, color: "text-emerald-600" },
  suggestion: { icon: Lightbulb, color: "text-violet-600" },
  triage: { icon: Shield, color: "text-blue-600" },
  user: { icon: User, color: "text-foreground" },
  response: { icon: Bot, color: "text-primary" },
};

function formatRelativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

function CardLink({ cardId, title }: { cardId: string; title: string }) {
  const setExpandedCard = useBoardStore((s) => s.setExpandedCard);

  return (
    <button
      onClick={() => setExpandedCard(cardId)}
      className="inline-flex items-center gap-0.5 font-medium text-foreground hover:text-primary hover:underline underline-offset-2 transition-colors text-left"
    >
      {title}
      <ExternalLink className="h-2.5 w-2.5 shrink-0 opacity-40" />
    </button>
  );
}

function InlinePendingInput({ card }: { card: KanbanCard }) {
  const setExpandedCard = useBoardStore((s) => s.setExpandedCard);
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
      <div className="mt-1.5 space-y-1">
        {question.message && (
          <p className="text-[10px] text-muted-foreground line-clamp-2">{question.message}</p>
        )}
        <div className="flex flex-wrap gap-1">
          {question.options.slice(0, 4).map((opt) => (
            <button
              key={opt.id}
              onClick={() => setExpandedCard(card.id)}
              className={cn(
                "rounded px-1.5 py-0.5 text-[10px] border transition-colors",
                opt.recommended
                  ? "bg-primary/10 border-primary/30 text-primary hover:bg-primary/20"
                  : "bg-muted/50 border-border hover:bg-muted"
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
        <p className="text-[10px] text-muted-foreground line-clamp-2 mb-1">
          {input.message || question?.message}
        </p>
      )}
      <button
        onClick={() => setExpandedCard(card.id)}
        className="inline-flex items-center gap-1 text-[10px] text-primary hover:underline underline-offset-2"
      >
        Open on board
        <ExternalLink className="h-2.5 w-2.5" />
      </button>
    </div>
  );
}

export function FeedItem({ type, message, timestamp, cardId, cardTitle }: FeedItemProps) {
  const config = typeConfig[type];
  const Icon = config.icon;
  const card = useBoardStore((s) => (cardId ? s.getCard(cardId) : undefined));

  const showInlineInput = type === "alert" && card?.pendingInput;

  return (
    <div
      className={cn(
        "flex gap-2 text-xs animate-in fade-in slide-in-from-top-2 duration-300",
        type === "user" && "bg-muted/50 -mx-3 px-3 py-1.5 rounded",
      )}
    >
      <div className={cn(
        "mt-1 w-0.5 shrink-0 rounded-full self-stretch",
        type === "intervention" && "bg-primary/40",
        type === "alert" && "bg-amber-500/40",
        type === "transition" && "bg-emerald-500/40",
        type === "suggestion" && "bg-violet-500/40",
        type === "triage" && "bg-blue-500/40",
        type === "user" && "bg-foreground/20",
        type === "response" && "bg-primary/40",
      )} />
      <Icon className={cn("h-3.5 w-3.5 mt-0.5 shrink-0", config.color)} />
      <div className="flex-1 min-w-0">
        <span className="text-muted-foreground">{formatRelativeTime(timestamp)}</span>

        {cardId && cardTitle ? (
          <div className="mt-0.5">
            <CardLink cardId={cardId} title={cardTitle} />
            <p className="text-muted-foreground leading-relaxed mt-0.5">{message}</p>
          </div>
        ) : (
          <p className="text-foreground leading-relaxed mt-0.5">{message}</p>
        )}

        {showInlineInput && card && <InlinePendingInput card={card} />}
      </div>
    </div>
  );
}
