"use client";

import { useState } from "react";
import { Check, ChevronRight, Loader2, X } from "lucide-react";

import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Phase,
  RuntimeStatus,
  PHASE_ORDER,
  type GateRunView,
  isGateRunStale,
} from "@/lib/types";
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
}

interface CardDiff {
  filesChanged: number;
  additions: number;
  deletions: number;
}

interface GatePipelineProps {
  cardId: string;
  currentPhase: Phase;
  gateStatus: "pending" | "evaluating" | "passed" | "failed";
  runtime: RuntimeStatus;
  /** Real gate runs for this card; when present, tooltips explain each verdict. */
  runs?: GateRunView[];
  /** Current diff dimensions, used to flag stale (out-of-date) verdicts. */
  cardDiff?: CardDiff;
}

const PHASE_LABELS: Record<Phase, string> = {
  define: "DEF",
  plan: "PLN",
  build: "BLD",
  review: "REV",
  ship: "SHP",
};

const PHASE_NAMES: Record<Phase, string> = {
  define: "Define",
  plan: "Plan",
  build: "Build",
  review: "Review",
  ship: "Ship",
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

function relativeTime(iso?: string): string {
  if (!iso) return "";
  const ts = Date.parse(iso.includes("Z") || iso.includes("+") ? iso : `${iso}Z`);
  if (Number.isNaN(ts)) return "";
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function gateLabel(run: GateRunView): string {
  return run.gateName ?? run.gateType;
}

/** Human description of what a gate verifies. */
function gateMethod(run: GateRunView): string {
  if (run.gateType === "human-approval") return "human approval";
  if (run.gateType === "review") return "reviewer";
  return run.gateType; // lint / typecheck / test / custom
}

export function GatePipeline({
  cardId,
  currentPhase,
  gateStatus,
  runtime,
  runs,
  cardDiff,
}: GatePipelineProps) {
  const [hoveredPhase, setHoveredPhase] = useState<Phase | null>(null);
  const currentIdx = PHASE_ORDER.indexOf(currentPhase);

  const steps: GateStep[] = PHASE_ORDER.map((phase, idx) => ({
    phase,
    status: getStepStatus(idx, currentIdx, gateStatus, runtime),
  }));

  // Group runs by the phase they gate the exit of (fromPhase). Runs arrive
  // newest-first, so keep only the latest run per gate identity — a superseded
  // old verdict must not trigger a false stale/failed signal on the strip.
  const runsByPhase = new Map<Phase, GateRunView[]>();
  if (runs) {
    const seenGate = new Set<string>();
    for (const run of runs) {
      const key = `${run.fromPhase}:${run.gateType}:${run.gateName ?? ""}`;
      if (seenGate.has(key)) continue;
      seenGate.add(key);
      const list = runsByPhase.get(run.fromPhase) ?? [];
      list.push(run);
      runsByPhase.set(run.fromPhase, list);
    }
  }

  const phaseHasStale = (phase: Phase): boolean => {
    if (!cardDiff) return false;
    const list = runsByPhase.get(phase);
    if (!list) return false;
    return list.some((r) => r.status === "passed" && isGateRunStale(r, cardDiff));
  };

  return (
    <TooltipProvider>
      <div className="flex items-center gap-0.5" data-card-id={cardId}>
        {steps.map(({ phase, status }, idx) => {
          const Icon = statusIcons[status];
          const phaseRuns = runsByPhase.get(phase);
          const stale = phaseHasStale(phase);

          return (
            <div key={phase} className="flex items-center">
              <Tooltip>
                <TooltipTrigger
                  aria-label={`${PHASE_NAMES[phase]} gate: ${status}${stale ? " (stale)" : ""}`}
                  className={cn(
                    "relative flex h-5 cursor-default items-center justify-center rounded px-1.5 text-[9px] font-bold transition-all outline-none",
                    statusColors[status],
                    status === "running" && "ring-1 ring-primary/30",
                    stale && "ring-1 ring-amber-400",
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
                  {stale && (
                    <span className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full bg-amber-400 ring-1 ring-background" />
                  )}
                </TooltipTrigger>
                <TooltipContent side="bottom" className="max-w-[260px] text-xs">
                  <p className="font-medium">{PHASE_NAMES[phase]}</p>
                  {phaseRuns && phaseRuns.length > 0 ? (
                    <ul className="mt-1 space-y-1">
                      {phaseRuns.map((run) => {
                        const runStale =
                          cardDiff && run.status === "passed" && isGateRunStale(run, cardDiff);
                        return (
                          <li key={run.id} className="flex flex-col">
                            <span className="flex items-center gap-1">
                              <span
                                className={cn(
                                  "font-medium",
                                  run.status === "passed" && "text-emerald-600",
                                  run.status === "failed" && "text-red-600"
                                )}
                              >
                                {gateLabel(run)}
                              </span>
                              <span className="text-muted-foreground">· {run.status}</span>
                              {run.completedAt && (
                                <span className="text-muted-foreground">
                                  · {relativeTime(run.completedAt)}
                                </span>
                              )}
                            </span>
                            <span className="text-[10px] text-muted-foreground">
                              via {gateMethod(run)}
                              {runStale && (
                                <span className="ml-1 text-amber-600">
                                  · ⚠ verified against older code
                                </span>
                              )}
                            </span>
                          </li>
                        );
                      })}
                    </ul>
                  ) : (
                    <p className="capitalize text-muted-foreground">{status}</p>
                  )}
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
