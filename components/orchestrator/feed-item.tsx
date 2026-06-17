"use client";

import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  Lightbulb,
  RefreshCw,
  User,
} from "lucide-react";
import { cn } from "@/lib/utils";

type FeedItemType =
  | "intervention"
  | "alert"
  | "transition"
  | "suggestion"
  | "user"
  | "response";

interface FeedItemProps {
  id: string;
  type: FeedItemType;
  message: string;
  timestamp: number;
}

const typeConfig: Record<FeedItemType, { icon: typeof RefreshCw; color: string }> = {
  intervention: { icon: RefreshCw, color: "text-primary" },
  alert: { icon: AlertTriangle, color: "text-amber-600" },
  transition: { icon: CheckCircle2, color: "text-emerald-600" },
  suggestion: { icon: Lightbulb, color: "text-violet-600" },
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

export function FeedItem({ type, message, timestamp }: FeedItemProps) {
  const config = typeConfig[type];
  const Icon = config.icon;

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
        type === "user" && "bg-foreground/20",
        type === "response" && "bg-primary/40",
      )} />
      <Icon className={cn("h-3.5 w-3.5 mt-0.5 shrink-0", config.color)} />
      <div className="flex-1 min-w-0">
        <span className="text-muted-foreground">{formatRelativeTime(timestamp)}</span>
        <p className="text-foreground leading-relaxed mt-0.5">{message}</p>
      </div>
    </div>
  );
}
