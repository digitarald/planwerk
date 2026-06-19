"use client";

import { Draggable } from "@hello-pangea/dnd";
import type { CSSProperties } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  CirclePause,
  Loader2,
  MessageCircleWarning,
  Shield,
  ShieldAlert,
  ShieldCheck,
  ShieldX,
  XCircle,

  Bug,
} from "lucide-react";

import { PendingInputCard } from "./pending-input-card";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { useBoardStore, selectShowWorkspaceTags } from "@/lib/store/board-store";
import { useOrchestratorStore } from "@/lib/store/orchestrator-store";
import {
  AttentionLevel,
  KanbanCard as KanbanCardType,
  RiskLevel,
  RuntimeStatus,
  GateStatus,
} from "@/lib/types";
import { cn } from "@/lib/utils";
import { copyDebugState } from "@/lib/utils/copy-debug-state";

interface KanbanCardProps {
  card: KanbanCardType;
  index: number;
}

const riskConfig: Record<RiskLevel, { color: string; label: string }> = {
  low: { color: "text-emerald-500", label: "Low risk" },
  medium: { color: "text-amber-500", label: "Medium risk" },
  high: { color: "text-red-500", label: "High risk" },
};

function RiskIndicator({ level }: { level: RiskLevel }) {
  const { color, label } = riskConfig[level];
  const Icon = level === "high" ? ShieldAlert : Shield;
  return (
    <span title={label}>
      <Icon className={cn("mt-0.5 h-3.5 w-3.5 shrink-0", color)} />
    </span>
  );
}

const attentionStyles: Record<AttentionLevel, string> = {
  none: "",
  "needs-human": "border-amber-400/60 animate-glow-amber",
  stale: "opacity-60",
  error: "shadow-glow-red border-red-400/60",
  conflict: "shadow-glow-purple border-purple-400/60",
};

function RuntimeIndicator({ status }: { status: RuntimeStatus }) {
  switch (status) {
    case "running":
      return <span title="Running"><Loader2 className="h-3 w-3 shrink-0 animate-spin text-primary" /></span>;
    case "idle":
      return <span title="Idle"><CirclePause className="h-3 w-3 shrink-0 text-muted-foreground/40" /></span>;
    case "input-needed":
      return (
        <span className="inline-flex shrink-0 items-center gap-0.5 rounded bg-amber-100 px-1 py-0.5 text-[9px] font-medium text-amber-700 dark:bg-amber-900/30 dark:text-amber-400" title="Waiting for input">
          <MessageCircleWarning className="h-2.5 w-2.5" />
          Input
        </span>
      );
    case "error":
      return (
        <span className="inline-flex shrink-0 items-center gap-0.5 rounded bg-red-100 px-1 py-0.5 text-[9px] font-medium text-red-700 dark:bg-red-900/30 dark:text-red-400" title="Error occurred">
          <XCircle className="h-2.5 w-2.5" />
          Error
        </span>
      );
  }
}

function InputContext({ card }: { card: KanbanCardType }) {
  // When we have structured pending input data, render the actionable UI
  if (card.pendingInput) {
    return <PendingInputCard cardId={card.id} input={card.pendingInput} />;
  }

  // Fallback: no input data yet (still subscribing), show activity text
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
      return <span title="Gates passed"><ShieldCheck className="h-3 w-3 shrink-0 text-emerald-500" /></span>;
    case "evaluating":
      return <span title="Evaluating gates"><Loader2 className="h-3 w-3 shrink-0 animate-spin text-primary/70" /></span>;
    case "failed":
      return (
        <span className="inline-flex shrink-0 items-center gap-0.5 rounded bg-red-100 px-1 py-0.5 text-[9px] font-medium text-red-700 dark:bg-red-900/30 dark:text-red-400" title="Gate check failed">
          <ShieldX className="h-2.5 w-2.5" />
          Gate
        </span>
      );
    case "pending":
      return null;
  }
}

function formatRelativeTime(timestamp: number): string {
  const diff = Math.max(0, Date.now() - timestamp);
  const seconds = Math.floor(diff / 1000);

  if (seconds < 60) return "now";

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;

  const days = Math.floor(hours / 24);
  return `${days}d`;
}

export function KanbanCard({ card, index }: KanbanCardProps) {
  const setDetailCard = useBoardStore((state) => state.setDetailCard);
  const showWorkspaceTags = useBoardStore(selectShowWorkspaceTags);
  const feedItems = useOrchestratorStore((s) => s.feedItems);
  const showPlanSteps = card.planSteps.total > 0;
  const showStats = card.filesChanged > 0;

  return (
    <Draggable draggableId={card.id} index={index} isDragDisabled={card.isArchived}>
      {(provided, snapshot) => {
        const { style, ...draggableProps } = provided.draggableProps;

        return (
          <ContextMenu>
            <ContextMenuTrigger
              ref={provided.innerRef}
              {...draggableProps}
              {...(card.isArchived ? {} : provided.dragHandleProps)}
              tabIndex={0}
              onClick={() => setDetailCard(card.id)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  setDetailCard(card.id);
                }
              }}
              style={style as CSSProperties | undefined}
              className={cn(
                "cursor-pointer rounded-lg border border-border/60 bg-card p-2 shadow-elevation-xs transition-all duration-150 hover:-translate-y-0.5 hover:shadow-elevation-sm hover:border-primary/30 focus-visible:ring-2 focus-visible:ring-primary/50 focus-visible:ring-offset-1",
                snapshot.isDragging && "scale-[1.02] shadow-elevation-lg border-primary/30",
                attentionStyles[card.attention],
                card.isArchived && "opacity-60"
              )}
            >
            <div className="flex items-start gap-1.5">
              {card.isArchived ? (
                <span title="Completed"><CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-500" /></span>
              ) : (
                <RiskIndicator level={card.risk} />
              )}
              <div className="min-w-0 flex-1">
                <h3 className="line-clamp-2 text-xs font-medium leading-tight">
                  <span>{card.title}</span>
                  {showWorkspaceTags && card.project && (
                    <span className="ml-1 text-[10px] font-normal text-muted-foreground/45">
                      · {card.project.name}
                    </span>
                  )}
                </h3>

                {card.runtime === "input-needed" && (
                  <InputContext card={card} />
                )}

                <div className="mt-1 flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
                  {card.runtime !== "input-needed" && (
                    <RuntimeIndicator status={card.runtime} />
                  )}
                  <GateIndicator status={card.gateStatus} />
                  {card.manualOverride && (
                    <span title="Manual override active"><AlertTriangle className="h-3 w-3 shrink-0 text-amber-500" /></span>
                  )}
                  {card.runtime !== "input-needed" && card.activity && (
                    <p className="min-w-0 flex-1 truncate">{card.activity}</p>
                  )}
                  {showPlanSteps && (
                    <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground/75">
                      {card.planSteps.done}/{card.planSteps.total}
                    </span>
                  )}
                </div>

                <div className="mt-1 text-[10px] text-muted-foreground/70">
                  {showStats && (
                    <>
                      <span className="text-emerald-600">+{card.additions}</span>{" "}
                      <span className="text-red-600">-{card.deletions}</span>
                      <span className="text-muted-foreground/45"> · </span>
                      <span>{card.filesChanged}f</span>
                      <span className="text-muted-foreground/45"> · </span>
                    </>
                  )}
                  <span>{formatRelativeTime(card.modifiedAt)}</span>
                </div>
              </div>
            </div>

            </ContextMenuTrigger>
            <ContextMenuContent>
              <ContextMenuItem
                onClick={() => copyDebugState(card, feedItems)}
              >
                <Bug className="h-3.5 w-3.5" />
                Copy debug state
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        );
      }}
    </Draggable>
  );
}
