"use client";

import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  X,
  Send,
  GitBranch,
  FileText,
  FileEdit as FilePen,
  FlaskConical,
  Lightbulb,
  BookOpen,
  ClipboardCheck,
  Scale,
  Clock,
  Shield,
  ShieldAlert,
  Loader2,
  CirclePause,
  AlertTriangle,
  ShieldCheck,
  ShieldX,
  MessageCircleWarning,
  XCircle,
  ChevronDown,
} from "lucide-react";

import { PendingInputCard } from "./pending-input-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import { useBoardStore } from "@/lib/store/board-store";
import { useConnectionStore } from "@/lib/store/connection-store";
import { useOrchestratorStore } from "@/lib/store/orchestrator-store";
import {
  KanbanCard,
  ArtifactType,
  StatusEntry,
  RiskLevel,
  RuntimeStatus,
  GateStatus,
  type GateRunView,
  isGateRunStale,
} from "@/lib/types";
import { GatePipeline } from "@/components/gates/gate-pipeline";
import { useGateRuns } from "@/lib/hooks/use-gate-runs";
import { cn } from "@/lib/utils";

const artifactIcons: Record<ArtifactType, typeof FileText> = {
  plan: FileText,
  research: FlaskConical,
  design: Lightbulb,
  spec: BookOpen,
  "test-plan": ClipboardCheck,
  decision: Scale,
};

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function shortenPath(fullPath: string, projectRoot?: string): { name: string; dir: string } {
  const normalized = fullPath.replace(/\/+$/, "");

  // Try to strip project root prefix
  if (projectRoot) {
    const root = projectRoot.replace(/\/+$/, "") + "/";
    if (normalized.startsWith(root)) {
      const relative = normalized.slice(root.length);
      const segments = relative.split("/");
      const name = segments.pop() ?? relative;
      const dir = segments.length > 0 ? segments.join("/") + "/" : "";
      return { name, dir };
    }
  }

  // Out-of-project file: show basename only
  const segments = normalized.split("/");
  const name = segments.pop() ?? normalized;
  return { name, dir: "" };
}

function RuntimeBadge({ status }: { status: RuntimeStatus }) {
  switch (status) {
    case "running":
      return (
        <span className="inline-flex items-center gap-1.5 rounded-md bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-400">
          <Loader2 className="h-3 w-3 animate-spin" />
          Running
        </span>
      );
    case "idle":
      return (
        <span className="inline-flex items-center gap-1.5 rounded-md bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
          <CirclePause className="h-3 w-3" />
          Idle
        </span>
      );
    case "input-needed":
      return (
        <span className="inline-flex items-center gap-1.5 rounded-md bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700 dark:bg-amber-950/30 dark:text-amber-400">
          <MessageCircleWarning className="h-3 w-3" />
          Input Needed
        </span>
      );
    case "error":
      return (
        <span className="inline-flex items-center gap-1.5 rounded-md bg-red-50 px-2 py-0.5 text-xs font-medium text-red-700 dark:bg-red-950/30 dark:text-red-400">
          <XCircle className="h-3 w-3" />
          Error
        </span>
      );
  }
}

function GateBadge({ status }: { status: GateStatus }) {
  switch (status) {
    case "passed":
      return (
        <span className="inline-flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400">
          <ShieldCheck className="h-3 w-3" />
          Passed
        </span>
      );
    case "evaluating":
      return (
        <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" />
          Evaluating
        </span>
      );
    case "failed":
      return (
        <span className="inline-flex items-center gap-1 text-xs text-red-600 dark:text-red-400">
          <ShieldX className="h-3 w-3" />
          Failed
        </span>
      );
    case "pending":
      return null;
  }
}

function gateRunRelativeTime(iso?: string): string {
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

function gateRunMethod(run: GateRunView): string {
  if (run.gateType === "human-approval") return "human approval";
  if (run.gateType === "review") return "reviewer";
  return `\`${run.gateType}\``;
}

/** One real gate verdict: what was checked, the result, freshness, and output. */
function GateRunRow({
  run,
  cardDiff,
}: {
  run: GateRunView;
  cardDiff: { filesChanged: number; additions: number; deletions: number };
}) {
  const stale = run.status === "passed" && isGateRunStale(run, cardDiff);

  return (
    <div
      className={cn(
        "rounded-lg border p-3",
        run.status === "passed" && "border-emerald-200 bg-emerald-50/50 dark:border-emerald-800 dark:bg-emerald-950/20",
        run.status === "failed" && "border-red-200 bg-red-50/50 dark:border-red-800 dark:bg-red-950/20",
        run.status === "running" && "border-blue-200 bg-blue-50/50 dark:border-blue-800 dark:bg-blue-950/20",
        stale && "border-amber-300 dark:border-amber-700"
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          {run.status === "passed" && <ShieldCheck className="h-3 w-3 shrink-0 text-emerald-600" />}
          {run.status === "failed" && <ShieldX className="h-3 w-3 shrink-0 text-red-600" />}
          {run.status === "running" && <Loader2 className="h-3 w-3 shrink-0 animate-spin text-blue-600" />}
          <span className="truncate text-xs font-medium">{run.gateName ?? run.gateType}</span>
          <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
            {run.fromPhase} → {run.toPhase}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {stale && (
            <span className="inline-flex items-center gap-0.5 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:bg-amber-900/40 dark:text-amber-300">
              <AlertTriangle className="h-2.5 w-2.5" />
              Stale
            </span>
          )}
          <span
            className={cn(
              "rounded px-1.5 py-0.5 text-[10px] font-medium",
              run.status === "passed" && "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300",
              run.status === "failed" && "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300",
              run.status === "running" && "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300"
            )}
          >
            {run.status}
          </span>
        </div>
      </div>
      <p className="mt-1 text-[11px] text-muted-foreground">
        Verified via {gateRunMethod(run)}
        {run.completedAt && ` · ${gateRunRelativeTime(run.completedAt)}`}
        {stale && (
          <span className="text-amber-600 dark:text-amber-400"> · verified against older code</span>
        )}
      </p>
      {run.output && (
        <pre className="mt-1.5 max-h-24 overflow-auto whitespace-pre-wrap rounded bg-muted/40 p-2 text-[10px] leading-snug text-muted-foreground">
          {run.output.length > 600 ? `${run.output.slice(0, 600)}…` : run.output}
        </pre>
      )}
    </div>
  );
}

const riskBadgeStyles: Record<RiskLevel, string> = {
  low: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-400",
  medium: "bg-amber-50 text-amber-700 dark:bg-amber-950/30 dark:text-amber-400",
  high: "bg-red-50 text-red-700 dark:bg-red-950/30 dark:text-red-400",
};

function RiskBadge({ level }: { level: RiskLevel }) {
  const Icon = level === "high" ? ShieldAlert : Shield;
  return (
    <span className={cn("inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-xs font-medium capitalize", riskBadgeStyles[level])}>
      <Icon className="h-3 w-3" />
      {level} risk
    </span>
  );
}

const markdownComponents = {
  a: ({ href, children, ...props }: React.ComponentProps<"a">) => (
    <a href={href} target="_blank" rel="noreferrer" {...props}>
      {children}
    </a>
  ),
  pre: ({ children, ...props }: React.ComponentProps<"pre">) => (
    <pre className="overflow-x-auto" {...props}>
      {children}
    </pre>
  ),
  table: ({ children, ...props }: React.ComponentProps<"table">) => (
    <div className="overflow-x-auto">
      <table {...props}>{children}</table>
    </div>
  ),
};

interface CardDetailModalProps {
  card: KanbanCard;
}

export function CardDetailModal({ card }: CardDetailModalProps) {
  const setDetailCard = useBoardStore((s) => s.setDetailCard);
  const addFeedItem = useOrchestratorStore((s) => s.addFeedItem);
  const hostUrl = useConnectionStore((s) => s.hostUrl);
  const [message, setMessage] = useState("");
  const [sendState, setSendState] = useState<"idle" | "sending" | "error">("idle");
  const [statusHistory, setStatusHistory] = useState<StatusEntry[]>(
    card.statusHistory ?? []
  );
  const scrimRef = useRef<HTMLDivElement>(null);

  // Signature of the newest recorded status so the timeline refetches when a new
  // status arrives on the live card (keeps the open modal from going stale).
  const latestStatus = card.statusHistory?.[card.statusHistory.length - 1];
  const latestStatusKey = latestStatus
    ? `${latestStatus.timestamp}-${latestStatus.message}`
    : "";

  // Fetch the fuller status-line history for the timeline. Falls back to the
  // last few entries already on the card while this loads.
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/cards/status-history?cardId=${encodeURIComponent(card.id)}&limit=20`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { entries?: StatusEntry[] } | null) => {
        if (!cancelled && data?.entries) setStatusHistory(data.entries);
      })
      .catch(() => {
        // Best-effort; keep the card-provided fallback.
      });
    return () => {
      cancelled = true;
    };
  }, [card.id, latestStatusKey]);

  // Real gate verdicts for this card — the modal is the judgment surface where
  // the user inspects *why* gates passed/failed and how fresh those verdicts are.
  const { runs: gateRuns } = useGateRuns(card.id, true);
  const cardDiff = {
    filesChanged: card.filesChanged,
    additions: card.additions,
    deletions: card.deletions,
  };

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDetailCard(null);
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [setDetailCard]);

  const handleInject = async (e: React.FormEvent) => {
    e.preventDefault();
    const text = message.trim();
    if (!text || sendState === "sending") return;
    if (!hostUrl) {
      setSendState("error");
      setTimeout(() => setSendState("idle"), 3000);
      return;
    }

    setSendState("sending");
    try {
      const res = await fetch("/api/ahp/sessions/message", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hostUrl, sessionUri: card.id, message: text }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to send");
      }
      const data = (await res.json()) as { queued?: boolean };
      addFeedItem({
        type: "intervention",
        message: `Message ${data.queued ? "queued for" : "sent to"} "${card.title}": "${text}"`,
        cardId: card.id,
      });
      setMessage("");
      setSendState("idle");
    } catch {
      setSendState("error");
      setTimeout(() => setSendState("idle"), 3000);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleInject(e);
    }
  };

  const artifacts = card.artifacts ?? [];
  const fileChanges = card.fileChanges ?? [];
  const planArtifact = artifacts.find(
    (a) => a.type === "plan" && a.contentRef
  );
  const [filesExpanded, setFilesExpanded] = useState(fileChanges.length <= 12);

  return (
    <div className="absolute inset-0 z-40 flex items-start justify-center">
      {/* Scrim */}
      <div
        ref={scrimRef}
        className="absolute inset-0 bg-black/10 backdrop-blur-[2px] animate-in fade-in duration-150"
        onClick={() => setDetailCard(null)}
      />

      {/* Modal */}
      <div className="absolute inset-4 z-50 grid grid-rows-[auto_1fr] overflow-hidden rounded-2xl border border-border bg-popover shadow-elevation-lg animate-in fade-in slide-in-from-bottom-2 duration-200">
        {/* Header */}
        <div className="flex items-start gap-3 border-b border-border/60 px-6 py-4">
          <div
            className={cn(
              "mt-2 h-2.5 w-2.5 shrink-0 rounded-full",
              card.runtime === "running" && "bg-emerald-500 animate-pulse",
              card.runtime === "idle" && "bg-muted-foreground/40",
              card.runtime === "input-needed" && "bg-amber-500 animate-pulse",
              card.runtime === "error" && "bg-red-500"
            )}
          />
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold leading-tight tracking-tight">
              {card.title}
            </h2>
            <div className="mt-2 flex flex-wrap items-center gap-3">
              <RuntimeBadge status={card.runtime} />
              <RiskBadge level={card.risk} />
              {card.riskFactors && card.riskFactors.length > 0 && (
                <span className="text-xs text-muted-foreground">
                  {card.riskFactors.join(" · ")}
                </span>
              )}
              <GateBadge status={card.gateStatus} />
              {card.manualOverride && (
                <span className="inline-flex items-center gap-1 text-xs text-amber-600">
                  <AlertTriangle className="h-3 w-3" />
                  Override
                </span>
              )}
              {card.planSteps.total > 0 && (
                <span className="text-xs tabular-nums text-muted-foreground">
                  {card.planSteps.done}/{card.planSteps.total} steps
                </span>
              )}
              {card.branch && (
                <Badge
                  variant="secondary"
                  className="h-5 gap-1 px-2 text-[11px]"
                >
                  <GitBranch className="h-2.5 w-2.5" />
                  {card.branch}
                </Badge>
              )}
              {card.filesChanged > 0 && (
                <span className="text-xs text-muted-foreground">
                  <span className="text-emerald-600">+{card.additions}</span>{" "}
                  <span className="text-red-600">-{card.deletions}</span>
                  <span className="mx-1 text-muted-foreground/40">·</span>
                  {card.filesChanged} files
                </span>
              )}
            </div>
            <div className="mt-3">
              <GatePipeline
                cardId={card.id}
                currentPhase={card.phase}
                gateStatus={card.gateStatus}
                runtime={card.runtime}
                runs={gateRuns}
                cardDiff={cardDiff}
              />
            </div>
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => setDetailCard(null)}
            className="shrink-0"
          >
            <X className="h-4 w-4" />
            <span className="sr-only">Close</span>
          </Button>
        </div>

        {/* Body: split pane */}
        <div className={cn(
          "grid min-h-0 grid-cols-1",
          planArtifact && "md:grid-cols-[1.1fr_1px_0.9fr]"
        )}>
          {/* Left pane */}
          <ScrollArea className="min-h-0">
            <div className="flex flex-col gap-5 p-6">
              {/* Current Activity — always visible */}
              {card.activity && (
                <section>
                  <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
                    Current Activity
                  </h3>
                  <p className="text-[13px] leading-relaxed text-foreground/80">
                    {card.activity}
                  </p>
                </section>
              )}

              {/* Status history */}
              {statusHistory.length > 0 && (
                <section>
                  <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
                    Status history
                  </h3>
                  <div className="relative space-y-0.5 pl-1">
                    {[...statusHistory].reverse().map((entry, idx) => {
                      const isCurrent = idx === 0;
                      return (
                        <div
                          key={`${entry.timestamp}-${idx}`}
                          className={cn(
                            "relative flex items-start gap-2.5 py-1.5 text-sm",
                            !isCurrent && "opacity-70"
                          )}
                        >
                          <div className="mt-0.5 flex w-4 shrink-0 flex-col items-center self-stretch">
                            <span
                              className={cn(
                                "mt-1 h-2 w-2 shrink-0 rounded-full",
                                isCurrent ? "bg-primary" : "bg-muted-foreground/40"
                              )}
                            />
                            {idx < statusHistory.length - 1 && (
                              <span className="mt-0.5 w-px flex-1 bg-border" />
                            )}
                          </div>
                          <span
                            className={cn(
                              "min-w-0 flex-1 text-[13px] leading-relaxed",
                              isCurrent ? "text-foreground/90" : "text-foreground/70"
                            )}
                          >
                            {entry.message}
                          </span>
                          <span className="flex shrink-0 items-center gap-1 text-[11px] tabular-nums text-muted-foreground/60">
                            <Clock className="h-3 w-3" />
                            {formatTime(entry.timestamp)}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </section>
              )}

              {/* Changed Files */}
              {fileChanges.length > 0 && (
                <section>
                  <button
                    type="button"
                    onClick={() => setFilesExpanded(!filesExpanded)}
                    className="mb-2 flex w-full items-center gap-1 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground hover:text-foreground transition-colors"
                  >
                    <ChevronDown className={cn("h-3 w-3 transition-transform", !filesExpanded && "-rotate-90")} />
                    Changed Files
                    <span className="ml-1 font-normal normal-case tabular-nums">({fileChanges.length})</span>
                  </button>
                  {filesExpanded && (
                    <div className="space-y-px rounded-lg border border-border/60 bg-muted/20 py-1">
                      {[...fileChanges]
                        .sort((a, b) => (b.added + b.removed) - (a.added + a.removed))
                        .map((file) => {
                          const display = shortenPath(file.path, card.project?.path ?? card.workingDirectory);
                          const hasStats = file.added > 0 || file.removed > 0;
                          return (
                            <div
                              key={file.path}
                              title={file.path}
                              className="group flex items-center gap-2 px-2.5 py-1 hover:bg-muted/50"
                            >
                              <FilePen className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />
                              <span className="min-w-0 flex-1 truncate text-[12px] font-mono">
                                <span className="text-foreground">{display.name}</span>
                                {display.dir && (
                                  <span className="ml-1.5 text-muted-foreground/50">{display.dir}</span>
                                )}
                              </span>
                              {hasStats && (
                                <span className="shrink-0 text-[11px] tabular-nums">
                                  {file.added > 0 && <span className="text-emerald-600">+{file.added}</span>}
                                  {file.added > 0 && file.removed > 0 && <span className="text-muted-foreground/40"> </span>}
                                  {file.removed > 0 && <span className="text-red-600">-{file.removed}</span>}
                                </span>
                              )}
                            </div>
                          );
                        })}
                    </div>
                  )}
                </section>
              )}

              {/* Last Agent Message (only when not awaiting input — input section shows it inline) */}
              {card.lastAgentMessage && !card.pendingInput && (
                <section>
                  <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
                    Last Response
                  </h3>
                  <div className="rounded-xl border border-border/60 bg-muted/30 p-4">
                    <article className="prose prose-sm dark:prose-invert max-w-none prose-p:text-[13px] prose-p:leading-relaxed prose-code:text-xs prose-code:bg-muted prose-code:px-1 prose-code:py-0.5 prose-code:rounded prose-pre:bg-muted prose-pre:border prose-pre:border-border">
                      <ReactMarkdown
                        remarkPlugins={[remarkGfm]}
                        components={markdownComponents}
                      >
                        {card.lastAgentMessage}
                      </ReactMarkdown>
                    </article>
                  </div>
                </section>
              )}

              {/* Gates — real verdicts from the gate engine, with freshness */}
              {gateRuns.length > 0 && (
                <section>
                  <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
                    Gates
                  </h3>
                  <div className="space-y-2">
                    {gateRuns.map((run) => (
                      <GateRunRow key={run.id} run={run} cardDiff={cardDiff} />
                    ))}
                  </div>
                </section>
              )}

              {/* Review Findings */}
              {card.reviewFindings && card.reviewFindings.length > 0 && (
                <section>
                  <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
                    Review Findings
                  </h3>
                  <div className="space-y-2">
                    {card.reviewFindings.map((review) => (
                      <div
                        key={review.id}
                        className={cn(
                          "rounded-lg border p-3",
                          review.status === "passed" && "border-emerald-200 bg-emerald-50/50 dark:border-emerald-800 dark:bg-emerald-950/20",
                          review.status === "failed" && "border-red-200 bg-red-50/50 dark:border-red-800 dark:bg-red-950/20",
                          review.status === "escalated" && "border-amber-200 bg-amber-50/50 dark:border-amber-800 dark:bg-amber-950/20",
                          review.status === "in-progress" && "border-blue-200 bg-blue-50/50 dark:border-blue-800 dark:bg-blue-950/20",
                        )}
                      >
                        <div className="flex items-center justify-between">
                          <span className="text-xs font-medium">{review.skillId}</span>
                          <span className={cn(
                            "text-[10px] font-medium px-1.5 py-0.5 rounded",
                            review.status === "passed" && "text-emerald-700 bg-emerald-100 dark:text-emerald-300 dark:bg-emerald-900/40",
                            review.status === "failed" && "text-red-700 bg-red-100 dark:text-red-300 dark:bg-red-900/40",
                            review.status === "escalated" && "text-amber-700 bg-amber-100 dark:text-amber-300 dark:bg-amber-900/40",
                            review.status === "in-progress" && "text-blue-700 bg-blue-100 dark:text-blue-300 dark:bg-blue-900/40",
                          )}>
                            {review.status === "in-progress" ? `reviewing (${review.iteration}/${review.maxIterations})` : review.status}
                          </span>
                        </div>
                        {review.summary && (
                          <p className="mt-1 text-[11px] text-muted-foreground">{review.summary}</p>
                        )}
                        {review.findings && review.findings.length > 0 && (
                          <ul className="mt-1.5 space-y-0.5">
                            {review.findings.slice(0, 5).map((finding, i) => (
                              <li key={i} className="text-[11px] text-muted-foreground flex gap-1">
                                <span className="shrink-0">•</span>
                                <span>{finding}</span>
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    ))}
                  </div>
                </section>
              )}

              {/* Pending Input */}
              {card.pendingInput && (
                <section>
                  <h3 className="mb-2.5 text-[10px] font-semibold uppercase tracking-widest text-amber-600 dark:text-amber-400">
                    Awaiting Input
                  </h3>
                  {/* Show last agent message as context when available */}
                  {card.lastAgentMessage && (
                    <div className="mb-3 rounded-lg border border-border/60 bg-muted/20 px-3 py-2.5">
                      <p className="mb-1 text-[9px] font-semibold uppercase tracking-wider text-muted-foreground/60">
                        Agent
                      </p>
                      <article className="prose prose-sm dark:prose-invert max-w-none prose-p:text-[12px] prose-p:leading-relaxed prose-p:my-1 prose-code:text-[11px] prose-code:bg-muted prose-code:px-1 prose-code:py-0.5 prose-code:rounded">
                        <ReactMarkdown
                          remarkPlugins={[remarkGfm]}
                          components={markdownComponents}
                        >
                          {card.lastAgentMessage.length > 500
                            ? card.lastAgentMessage.slice(0, 500) + "…"
                            : card.lastAgentMessage}
                        </ReactMarkdown>
                      </article>
                    </div>
                  )}
                  <PendingInputCard cardId={card.id} input={card.pendingInput} />
                </section>
              )}

              {/* Artifacts (non-plan) */}
              {artifacts.filter((a) => a.type !== "plan").length > 0 && (
                <section>
                  <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
                    Artifacts
                  </h3>
                  <div className="space-y-1">
                    {artifacts
                      .filter((a) => a.type !== "plan")
                      .map((artifact) => {
                        const Icon = artifactIcons[artifact.type];
                        return (
                          <div
                            key={artifact.id}
                            className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted/50"
                          >
                            <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                            <span className="min-w-0 flex-1 truncate text-[13px]">
                              {artifact.title}
                            </span>
                            <span className="text-[10px] capitalize text-muted-foreground/60">
                              {artifact.status}
                            </span>
                          </div>
                        );
                      })}
                  </div>
                </section>
              )}

              {/* Message Input */}
              <section className="mt-auto pt-2">
                <form onSubmit={handleInject} className="relative">
                  <Textarea
                    value={message}
                    onChange={(e) => setMessage(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder="Send instructions to this session..."
                    disabled={sendState === "sending"}
                    className="min-h-[3rem] resize-none pr-10 text-[13px]"
                    rows={2}
                  />
                  <Button
                    type="submit"
                    size="icon-sm"
                    variant="ghost"
                    disabled={!message.trim() || sendState === "sending"}
                    className="absolute bottom-2 right-2"
                  >
                    {sendState === "sending" ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Send className="h-3.5 w-3.5" />
                    )}
                  </Button>
                </form>
                {sendState === "error" && (
                  <p className="mt-1 text-[11px] text-destructive">
                    Failed to send — check the connection and try again.
                  </p>
                )}
              </section>
            </div>
          </ScrollArea>

          {/* Divider + Right pane — only when plan exists */}
          {planArtifact && (
            <>
              <div className="hidden bg-border/60 md:block" />
              <ScrollArea className="hidden min-h-0 md:block">
                <div className="p-6">
                  <div className="mb-4 flex items-center gap-2">
                    <div className="flex h-6 w-6 items-center justify-center rounded-md bg-primary/10">
                      <FileText className="h-3.5 w-3.5 text-primary" />
                    </div>
                    <h3 className="text-sm font-semibold">
                      {planArtifact.title}
                    </h3>
                  </div>
                  <article className="prose prose-sm dark:prose-invert max-w-none prose-headings:font-semibold prose-h1:text-base prose-h2:text-sm prose-h2:mt-5 prose-h2:mb-2 prose-h3:text-xs prose-p:text-[13px] prose-p:leading-relaxed prose-li:text-[13px] prose-table:text-xs prose-pre:bg-muted prose-pre:border prose-pre:border-border prose-code:text-[12px] prose-strong:font-semibold">
                    <ReactMarkdown
                      remarkPlugins={[remarkGfm]}
                      components={markdownComponents}
                    >
                      {planArtifact.contentRef!}
                    </ReactMarkdown>
                  </article>
                </div>
              </ScrollArea>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
