"use client";

import { Draggable } from "@hello-pangea/dnd";
import type { CSSProperties } from "react";
import { AlertTriangle } from "lucide-react";

import { CardExpansion } from "./card-expansion";
import { Badge } from "@/components/ui/badge";
import { useBoardStore } from "@/lib/store/board-store";
import {
  AttentionLevel,
  KanbanCard as KanbanCardType,
  RiskLevel,
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

const runtimeLabels = {
  idle: "Idle",
  running: "Running",
  "input-needed": "Needs input",
  error: "Error",
} as const;

const gateLabels = {
  pending: "Gate pending",
  evaluating: "Gate evaluating",
  passed: "Gate passed",
  failed: "Gate failed",
} as const;

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
  const isExpanded = expandedCardId === card.id;

  return (
    <Draggable draggableId={card.id} index={index}>
      {(provided, snapshot) => {
        const { style, ...draggableProps } = provided.draggableProps;

        return (
          <div
            ref={provided.innerRef}
            {...draggableProps}
            {...provided.dragHandleProps}
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
              "cursor-pointer rounded-xl border border-border bg-card p-3 transition-all hover:border-primary/30 hover:shadow-sm focus-visible:ring-2 focus-visible:ring-primary/50 focus-visible:ring-offset-1",
              snapshot.isDragging && "rotate-1 shadow-lg",
              attentionStyles[card.attention]
            )}
          >
            <div className="mb-1.5 flex items-start gap-2">
              <div
                className={cn(
                  "mt-1 h-2 w-2 shrink-0 rounded-full",
                  riskColors[card.risk]
                )}
              />
              <div className="min-w-0 flex-1">
                <h3 className="line-clamp-2 text-sm leading-tight font-medium">
                  {card.title}
                </h3>
              </div>
            </div>

            <p className="mb-2 line-clamp-2 pl-4 text-[11px] text-muted-foreground">
              {card.activity}
            </p>

            <div className="flex flex-wrap items-center gap-1.5 pl-4">
              <Badge variant="secondary" className="h-5 text-[10px]">
                {runtimeLabels[card.runtime]}
              </Badge>
              <Badge variant="outline" className="h-5 text-[10px]">
                {gateLabels[card.gateStatus]}
              </Badge>
              {card.manualOverride && (
                <Badge
                  variant="outline"
                  className="h-5 gap-1 border-amber-300 bg-amber-50 text-[10px] text-amber-700"
                >
                  <AlertTriangle className="h-3 w-3" />
                  Manual override
                </Badge>
              )}
            </div>

            <div className="mt-2 flex items-center gap-1.5 pl-4 text-[10px] text-muted-foreground">
              {card.filesChanged > 0 && (
                <>
                  <span className="text-emerald-600">+{card.additions}</span>
                  <span className="text-red-600">-{card.deletions}</span>
                  <span>· {card.filesChanged} files</span>
                  <span>·</span>
                </>
              )}
              <span>{formatRelativeTime(card.modifiedAt)}</span>
            </div>

            {card.planSteps.total > 0 && (
              <div className="mt-2 flex items-center gap-1.5 pl-4">
                <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full bg-primary/60 transition-all"
                    style={{
                      width: `${(card.planSteps.done / card.planSteps.total) * 100}%`,
                    }}
                  />
                </div>
                <span className="text-[10px] text-muted-foreground">
                  {card.planSteps.done}/{card.planSteps.total}
                </span>
              </div>
            )}

            {/* Expanded view */}
            {isExpanded && <CardExpansion card={card} />}
          </div>
        );
      }}
    </Draggable>
  );
}
