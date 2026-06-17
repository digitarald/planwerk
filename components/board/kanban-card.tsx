"use client";

import { Draggable } from "@hello-pangea/dnd";
import type { CSSProperties } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  CirclePause,
  Loader2,
  MessageCircleWarning,
  ShieldCheck,
  ShieldX,
  XCircle,
  ChevronDown,
} from "lucide-react";

import { CardExpansion } from "./card-expansion";
import { useBoardStore, selectShowWorkspaceTags } from "@/lib/store/board-store";
import {
  AttentionLevel,
  KanbanCard as KanbanCardType,
  RiskLevel,
  RuntimeStatus,
  GateStatus,
} from "@/lib/types";
import { cn } from "@/lib/utils";

interface KanbanCardProps {
  card: KanbanCardType;
  index: number;
}

const riskColors: Record<RiskLevel, string> = {
  low: "bg-emerald-500",
  medium: "bg-amber-500",
  high: "bg-red-500",
};

const attentionStyles: Record<AttentionLevel, string> = {
  none: "",
  "needs-human": "border-amber-400 animate-pulse-border",
  stale: "opacity-60",
  error: "border-red-400",
  conflict: "border-purple-400",
};

function RuntimeIndicator({ status }: { status: RuntimeStatus }) {
  switch (status) {
    case "running":
      return <Loader2 className="h-3 w-3 animate-spin text-primary" />;
    case "idle":
      return <CirclePause className="h-3 w-3 text-muted-foreground/40" />;
    case "input-needed":
      return (
        <span className="inline-flex items-center gap-0.5 rounded bg-amber-100 px-1 py-0.5 text-[9px] font-medium text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">
          <MessageCircleWarning className="h-2.5 w-2.5" />
          Input
        </span>
      );
    case "error":
      return (
        <span className="inline-flex items-center gap-0.5 rounded bg-red-100 px-1 py-0.5 text-[9px] font-medium text-red-700 dark:bg-red-900/30 dark:text-red-400">
          <XCircle className="h-2.5 w-2.5" />
          Error
        </span>
      );
  }
}

/** Shows the activity text as a question and the last tool call for context */
function InputContext({ card }: { card: KanbanCardType }) {
  const lastTool = card.recentActivity?.findLast((e) => e.type === "tool");
  return (
    <div className="mt-1 space-y-0.5 rounded border border-amber-200 bg-amber-50 px-1.5 py-1 dark:border-amber-800/40 dark:bg-amber-950/20">
      <p className="line-clamp-2 text-[11px] font-medium text-amber-800 dark:text-amber-300">
        {card.activity || "Waiting for input"}
      </p>
      {lastTool && (
        <p className="line-clamp-1 text-[10px] text-amber-700/70 dark:text-amber-400/60">
          ↳ {lastTool.message}
        </p>
      )}
    </div>
  );
}

function GateIndicator({ status }: { status: GateStatus }) {
  switch (status) {
    case "passed":
      return <ShieldCheck className="h-3 w-3 text-emerald-500" />;
    case "evaluating":
      return <Loader2 className="h-3 w-3 animate-spin text-primary/70" />;
    case "failed":
      return (
        <span className="inline-flex items-center gap-0.5 rounded bg-red-100 px-1 py-0.5 text-[9px] font-medium text-red-700 dark:bg-red-900/30 dark:text-red-400">
          <ShieldX className="h-2.5 w-2.5" />
          Gate
        </span>
      );
    case "pending":
      return null;
  }
}

function formatRelativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const seconds = Math.floor(diff / 1000);

  if (seconds < 60) return "just now";

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

export function KanbanCard({ card, index }: KanbanCardProps) {
  const setExpandedCard = useBoardStore((state) => state.setExpandedCard);
  const expandedCardId = useBoardStore((state) => state.expandedCardId);
  const showWorkspaceTags = useBoardStore(selectShowWorkspaceTags);
  const isExpanded = expandedCardId === card.id;

  return (
    <Draggable draggableId={card.id} index={index} isDragDisabled={card.isArchived}>
      {(provided, snapshot) => {
        const { style, ...draggableProps } = provided.draggableProps;

        return (
          <div
            ref={provided.innerRef}
            {...draggableProps}
            {...(card.isArchived ? {} : provided.dragHandleProps)}
            tabIndex={0}
            onClick={() => setExpandedCard(isExpanded ? null : card.id)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                setExpandedCard(isExpanded ? null : card.id);
              }
              if (e.key === "Escape" && isExpanded) {
                setExpandedCard(null);
              }
            }}
            style={style as CSSProperties | undefined}
            className={cn(
              "cursor-pointer rounded-lg border border-border bg-card p-2 transition-all hover:border-primary/30 hover:shadow-sm focus-visible:ring-2 focus-visible:ring-primary/50 focus-visible:ring-offset-1",
              snapshot.isDragging && "rotate-1 shadow-lg",
              attentionStyles[card.attention],
              card.isArchived && "opacity-60"
            )}
          >
            {/* Header: risk dot + title */}
            <div className="flex items-start gap-1.5">
              {card.isArchived ? (
                <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-500" />
              ) : (
                <div
                  className={cn(
                    "mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full",
                    riskColors[card.risk]
                  )}
                />
              )}
              <h3 className="min-w-0 flex-1 line-clamp-2 text-xs font-medium leading-tight">
                {card.title}
              </h3>
            </div>

            {/* Status indicators + activity */}
            <div className="mt-1 flex items-center gap-1.5 pl-3">
              <RuntimeIndicator status={card.runtime} />
              <GateIndicator status={card.gateStatus} />
              {card.manualOverride && (
                <AlertTriangle className="h-3 w-3 text-amber-500" />
              )}
            </div>

            {card.runtime === "input-needed" ? (
              <InputContext card={card} />
            ) : (
              <p className="mt-1 line-clamp-1 pl-3 text-[11px] text-muted-foreground">
                {card.activity}
              </p>
            )}

            {/* Compact stats row */}
            <div className="mt-1.5 flex items-center gap-2 pl-3 text-[10px] text-muted-foreground/70">
              {card.filesChanged > 0 && (
                <span>
                  <span className="text-emerald-600">+{card.additions}</span>{" "}
                  <span className="text-red-600">-{card.deletions}</span>{" "}
                  · {card.filesChanged}f
                </span>
              )}
              {card.planSteps.total > 0 && (
                <span>{card.planSteps.done}/{card.planSteps.total} steps</span>
              )}
              <span className="ml-auto">{formatRelativeTime(card.modifiedAt)}</span>
            </div>

            {/* Workspace tag — shown when multiple workspaces visible */}
            {showWorkspaceTags && card.project && (
              <div className="mt-1 pl-3 text-[10px] text-muted-foreground/50 truncate">
                {card.project.name}
              </div>
            )}

            {/* Expanded view */}
            {isExpanded && (
              <>
                <CardExpansion card={card} />
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setExpandedCard(null);
                  }}
                  className="mt-1.5 flex w-full items-center justify-center gap-0.5 rounded py-0.5 text-[10px] text-muted-foreground hover:bg-muted/50 hover:text-foreground"
                >
                  <ChevronDown className="h-3 w-3 rotate-180" />
                  Collapse
                </button>
              </>
            )}
          </div>
        );
      }}
    </Draggable>
  );
}
