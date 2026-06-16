"use client";

import { useState } from "react";
import { Check, ChevronRight, Loader2, X } from "lucide-react";

import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Phase, RuntimeStatus } from "@/lib/types";
import { cn } from "@/lib/utils";

type GateDisplayStatus =
  | "passed"
  | "running"
  | "failed"
  | "pending"
  | "not-required";

interface GateStep {
  phase: Phase;
  status: GateDisplayStatus;
  gates?: Array<{
    type: string;
    status: GateDisplayStatus;
    output?: string;
  }>;
}

interface GatePipelineProps {
  cardId: string;
  currentPhase: Phase;
  gateStatus: "pending" | "evaluating" | "passed" | "failed";
  runtime: RuntimeStatus;
}

const PHASE_ORDER: Phase[] = ["define", "plan", "build", "verify", "review", "ship"];

const PHASE_LABELS: Record<Phase, string> = {
  define: "DEF",
  plan: "PLN",
  build: "BLD",
  verify: "VER",
  review: "REV",
  ship: "SHP",
};

const statusIcons: Record<GateDisplayStatus, typeof Check | null> = {
  passed: Check,
  running: Loader2,
  failed: X,
  pending: null,
  "not-required": null,
};

const statusColors: Record<GateDisplayStatus, string> = {
  passed: "bg-emerald-500 text-white",
  running: "bg-primary text-white",
  failed: "bg-red-500 text-white",
  pending: "bg-muted border border-border text-muted-foreground",
  "not-required": "bg-muted/30 text-muted-foreground/40",
};

export function GatePipeline({
  cardId,
  currentPhase,
  gateStatus,
  runtime,
}: GatePipelineProps) {
  const [hoveredPhase, setHoveredPhase] = useState<Phase | null>(null);
  const currentIdx = PHASE_ORDER.indexOf(currentPhase);

  const steps: GateStep[] = PHASE_ORDER.map((phase, idx) => ({
    phase,
    status: getStepStatus(idx, currentIdx, gateStatus, runtime),
  }));

  return (
    <TooltipProvider>
      <div className="flex items-center gap-0.5" data-card-id={cardId}>
        {steps.map(({ phase, status }, idx) => {
          const Icon = statusIcons[status];

          return (
            <div key={phase} className="flex items-center">
              <Tooltip>
                <TooltipTrigger
                  aria-label={`${cardId}-${phase}-gate`}
                  className={cn(
                    "flex h-5 cursor-default items-center justify-center rounded px-1.5 text-[9px] font-bold transition-all outline-none",
                    statusColors[status],
                    status === "running" && "ring-1 ring-primary/30",
                    hoveredPhase === phase && "scale-105 shadow-sm"
                  )}
                  onMouseEnter={() => setHoveredPhase(phase)}
                  onMouseLeave={() => setHoveredPhase(null)}
                >
                  {Icon ? (
                    <Icon className={cn("h-2.5 w-2.5", status === "running" && "animate-spin")} />
                  ) : (
                    <span>{PHASE_LABELS[phase]}</span>
                  )}
                </TooltipTrigger>
                <TooltipContent side="bottom" className="text-xs">
                  <p className="font-medium capitalize">{phase}</p>
                  <p className="capitalize text-muted-foreground">{status}</p>
                </TooltipContent>
              </Tooltip>
              {idx < steps.length - 1 && (
                <ChevronRight className="mx-0.5 h-3 w-3 text-muted-foreground/40" />
              )}
            </div>
          );
        })}
      </div>
    </TooltipProvider>
  );
}

function getStepStatus(
  idx: number,
  currentIdx: number,
  gateStatus: GatePipelineProps["gateStatus"],
  runtime: GatePipelineProps["runtime"]
): GateDisplayStatus {
  if (idx < currentIdx) {
    return "passed";
  }

  if (idx === currentIdx) {
    if (gateStatus === "failed") {
      return "failed";
    }

    if (gateStatus === "evaluating") {
      return "running";
    }

    if (runtime === "running") {
      return "running";
    }

    return "pending";
  }

  return "not-required";
}
