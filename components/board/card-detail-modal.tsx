"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
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
  Split,
  Cpu,
  Bot,
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
import type { ChangesetReview } from "@/lib/types";
import { GatePipeline } from "@/components/gates/gate-pipeline";
import { useGateRuns } from "@/lib/hooks/use-gate-runs";
import { cn } from "@/lib/utils";
import { isGenericStatus } from "@/lib/utils/status-placeholders";
import {
  RUNTIME_STATUS,
  GATE_STATUS,
  blockedFromAdvancingHint,
} from "@/lib/utils/status-vocabulary";

const artifactIcons: Record<ArtifactType, typeof FileText> = {
  plan: FileText,
  review: ClipboardCheck,
  research: FlaskConical,
  design: Lightbulb,
  spec: BookOpen,
  "test-plan": ClipboardCheck,
  decision: Scale,
};

/** Single source of truth for the modal's compact section-header typography.
 *  Every panel label shares it so the rhythm can't drift; variants (icon row,
 *  amber "Awaiting Input", the collapsible Changed Files button) layer on top. */
const SECTION_LABEL_CLASS =
  "text-xs font-semibold leading-4 text-foreground/65";

function SectionLabel({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return <h3 className={cn("mb-2", SECTION_LABEL_CLASS, className)}>{children}</h3>;
}

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
        <span title={RUNTIME_STATUS.running.hint} className="inline-flex items-center gap-1.5 rounded-md bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-400">
          <Loader2 className="h-3 w-3 animate-spin" />
          {RUNTIME_STATUS.running.label}
        </span>
      );
    case "idle":
      return (
        <span title={RUNTIME_STATUS.idle.hint} className="inline-flex items-center gap-1.5 rounded-md bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
          <CirclePause className="h-3 w-3" />
          {RUNTIME_STATUS.idle.label}
        </span>
      );
    case "input-needed":
      return (
        <span title={RUNTIME_STATUS["input-needed"].hint} className="inline-flex items-center gap-1.5 rounded-md bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700 dark:bg-amber-950/30 dark:text-amber-400">
          <MessageCircleWarning className="h-3 w-3" />
          {RUNTIME_STATUS["input-needed"].label}
        </span>
      );
    case "error":
      return (
        <span title={RUNTIME_STATUS.error.hint} className="inline-flex items-center gap-1.5 rounded-md bg-red-50 px-2 py-0.5 text-xs font-medium text-red-700 dark:bg-red-950/30 dark:text-red-400">
          <XCircle className="h-3 w-3" />
          {RUNTIME_STATUS.error.label}
        </span>
      );
  }
}

function GateBadge({ status }: { status: GateStatus }) {
  switch (status) {
    case "passed":
      return (
        <span title={GATE_STATUS.passed.hint} className="inline-flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400">
          <ShieldCheck className="h-3 w-3" />
          {GATE_STATUS.passed.label}
        </span>
      );
    case "evaluating":
      return (
        <span title={GATE_STATUS.evaluating.hint} className="inline-flex items-center gap-1 text-xs text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" />
          {GATE_STATUS.evaluating.label}
        </span>
      );
    case "failed":
      return (
        <span title={GATE_STATUS.failed.hint} className="inline-flex items-center gap-1 text-xs text-red-600 dark:text-red-400">
          <ShieldX className="h-3 w-3" />
          {GATE_STATUS.failed.label}
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
  cardDiff: {
    filesChanged: number;
    additions: number;
    deletions: number;
    changesetVerified?: boolean;
    planContentHash?: string;
  };
}) {
  const stale = run.status === "passed" && isGateRunStale(run, cardDiff);
  const RunIcon =
    run.status === "passed"
      ? ShieldCheck
      : run.status === "failed"
        ? ShieldX
        : Loader2;

  return (
    <div
      className={cn(
        "rounded-lg border border-border/70 bg-muted/15 p-3.5",
        run.status === "failed" && "border-destructive/35 bg-destructive/[0.025]",
        run.status === "running" && "border-primary/25 bg-primary/[0.025]",
        stale && "border-pw-warning/55"
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <RunIcon
            aria-hidden="true"
            strokeWidth={1.8}
            className={cn(
              "h-4 w-4 shrink-0",
              run.status === "passed" && "text-pw-success",
              run.status === "failed" && "text-destructive",
              run.status === "running" && "animate-spin text-primary",
            )}
          />
          <span className="truncate text-[13px] font-semibold leading-5">{run.gateName ?? run.gateType}</span>
          <span className="text-[11px] font-medium text-muted-foreground">
            {run.fromPhase} → {run.toPhase}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {stale && (
            <span className="inline-flex items-center gap-1 rounded-md bg-pw-warning/15 px-2 py-1 text-[11px] font-semibold text-foreground">
              <AlertTriangle className="h-3 w-3 text-pw-warning" />
              Stale
            </span>
          )}
          <span
            className={cn(
              "rounded-md px-2 py-1 text-[11px] font-semibold capitalize",
              run.status === "passed" && "bg-pw-success/12 text-foreground",
              run.status === "failed" && "bg-destructive/10 text-destructive",
              run.status === "running" && "bg-primary/10 text-primary"
            )}
          >
            {run.status}
          </span>
        </div>
      </div>
      <p className="mt-1.5 text-xs leading-5 text-muted-foreground">
        Verified via {gateRunMethod(run)}
        {run.completedAt && ` · ${gateRunRelativeTime(run.completedAt)}`}
        {stale && (
          <span className="text-foreground"> · verified against older code</span>
        )}
      </p>
      {run.output && (
        <pre className="mt-2 max-h-24 overflow-auto whitespace-pre-wrap rounded-md border border-border/50 bg-background/55 p-2.5 text-[11px] leading-relaxed text-foreground/70">
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

function formatTokenCount(value: number): string {
  return new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

function workerTokenTotal(worker: NonNullable<KanbanCard["workers"]>[number]): number | undefined {
  if (!worker.usage) return undefined;
  const total = (worker.usage.inputTokens ?? 0) + (worker.usage.outputTokens ?? 0);
  return total > 0 ? total : undefined;
}

function WorkerActivitySection({ card }: { card: KanbanCard }) {
  const workers = card.workers;
  const [completedExpanded, setCompletedExpanded] = useState(false);
  if (!workers || workers.length === 0) return null;

  const foregroundWorkers = workers.filter(
    (worker) => worker.isActive || worker.runtime !== "idle",
  );
  const activeWorkerCount = workers.filter((worker) => worker.isActive).length;
  const attentionWorkerCount = foregroundWorkers.length - activeWorkerCount;
  const foregroundWorkerIds = new Set(foregroundWorkers.map((worker) => worker.id));
  const completedWorkers = workers.filter(
    (worker) => !worker.isActive && worker.runtime === "idle",
  );
  const completedTokens = completedWorkers.reduce(
    (total, worker) => total + (workerTokenTotal(worker) ?? 0),
    0,
  );

  return (
    <section>
      <SectionLabel className="flex items-center gap-1.5">
        <Bot aria-hidden="true" className="h-3.5 w-3.5 text-primary" strokeWidth={1.8} />
        Worker activity
        <span className="font-normal normal-case tracking-normal text-muted-foreground">
          ({activeWorkerCount} active
          {attentionWorkerCount > 0 && ` · ${attentionWorkerCount} needs attention`}
          {completedWorkers.length > 0 && ` · ${completedWorkers.length} completed`})
        </span>
      </SectionLabel>
      <div>
        {workers.map((worker) => (
          <div
            key={worker.id}
            aria-hidden={!foregroundWorkerIds.has(worker.id)}
            className={cn(
              "grid transition-[grid-template-rows,opacity,transform] duration-200 ease-[cubic-bezier(0.16,1,0.3,1)]",
              foregroundWorkerIds.has(worker.id)
                ? "grid-rows-[1fr] opacity-100"
                : "pointer-events-none -translate-y-1 grid-rows-[0fr] opacity-0",
            )}
          >
            <div className="overflow-hidden">
              <div
                className={cn(
                  "mb-2 rounded-lg border border-border/70 bg-muted/15 p-3.5",
                  worker.runtime === "running" && "border-primary/25 bg-primary/[0.025]",
                  worker.runtime === "input-needed" && "border-pw-warning/55",
                  worker.runtime === "error" && "border-destructive/35 bg-destructive/[0.025]",
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="flex min-w-0 items-center gap-2 truncate text-[13px] font-semibold">
                    {worker.runtime === "running" && (
                      <Loader2 aria-hidden="true" className="h-4 w-4 shrink-0 animate-spin text-primary" strokeWidth={1.8} />
                    )}
                    <span className="truncate">{worker.title}</span>
                  </span>
                  <span className={cn(
                    "shrink-0 rounded-md px-2 py-1 text-[11px] font-semibold",
                    worker.runtime === "running" && "bg-primary/10 text-primary",
                    worker.runtime === "input-needed" && "bg-pw-warning/15 text-foreground",
                    worker.runtime === "error" && "bg-destructive/10 text-destructive",
                  )}>
                    {worker.runtime === "running" ? "working" : worker.runtime}
                  </span>
                </div>
                {worker.activity && (
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">{worker.activity}</p>
                )}
                {worker.history.length > 0 && (
                  <div className="mt-2 border-l border-border pl-2">
                    {worker.history.slice(-3).reverse().map((entry) => (
                      <p key={`${entry.timestamp}-${entry.message}`} className="text-[10px] leading-relaxed text-muted-foreground/75">
                        {entry.message}
                      </p>
                    ))}
                  </div>
                )}
                {worker.usage && (
                  <p
                    className="mt-2 text-[11px] tabular-nums text-muted-foreground"
                    title="Live usage reported by the worker chat"
                  >
                    {worker.usage.inputTokens !== undefined && `${formatTokenCount(worker.usage.inputTokens)} in`}
                    {worker.usage.inputTokens !== undefined && worker.usage.outputTokens !== undefined && " · "}
                    {worker.usage.outputTokens !== undefined && `${formatTokenCount(worker.usage.outputTokens)} out`}
                    {worker.usage.cacheReadTokens !== undefined && ` · ${formatTokenCount(worker.usage.cacheReadTokens)} cached`}
                  </p>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>

      {completedWorkers.length > 0 && (
        <div className={cn(foregroundWorkers.length > 0 && "mt-1")}>
          <button
            type="button"
            aria-expanded={completedExpanded}
            onClick={() => setCompletedExpanded((expanded) => !expanded)}
            className="flex h-8 w-full items-center gap-2 rounded-lg border border-border/60 bg-muted/20 px-2.5 text-left text-[11px] text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground"
          >
            <ChevronDown
              className={cn(
                "h-3 w-3 shrink-0 -rotate-90 transition-transform duration-200",
                completedExpanded && "rotate-0",
              )}
            />
            <span className="font-medium text-foreground/80">
              {completedWorkers.length} completed {completedWorkers.length === 1 ? "worker" : "workers"}
            </span>
            {completedTokens > 0 && (
              <>
                <span className="text-border">·</span>
                <span className="tabular-nums">{formatTokenCount(completedTokens)} tokens</span>
              </>
            )}
            <span className="ml-auto text-[10px]">
              {completedExpanded ? "Hide" : "Show"}
            </span>
          </button>

          {completedExpanded && (
            <div className="scrollbar-thin mt-2 flex max-h-28 flex-wrap content-start gap-1.5 overflow-y-auto pr-1 animate-in fade-in slide-in-from-top-1 duration-150">
              {completedWorkers.map((worker) => {
                const tokens = workerTokenTotal(worker);
                return (
                  <span
                    key={worker.id}
                    title={worker.activity ?? worker.title}
                    className="inline-flex h-6 max-w-full items-center gap-1.5 rounded-full border border-border/60 bg-muted/25 px-2 text-[10px] text-muted-foreground"
                  >
                    <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-muted-foreground/35" />
                    <span className="max-w-48 truncate">{worker.title}</span>
                    {tokens !== undefined && (
                      <span className="shrink-0 tabular-nums text-muted-foreground/70">
                        {formatTokenCount(tokens)}
                      </span>
                    )}
                  </span>
                );
              })}
            </div>
          )}
        </div>
      )}
    </section>
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
  const updateCard = useBoardStore((s) => s.updateCard);
  const reconcileCard = useBoardStore((s) => s.reconcileCard);
  const addFeedItem = useOrchestratorStore((s) => s.addFeedItem);
  const hostUrl = useConnectionStore((s) => s.hostUrl);
  const [message, setMessage] = useState("");
  const [sendState, setSendState] = useState<"idle" | "sending" | "error">("idle");
  const [dismissingPeer, setDismissingPeer] = useState<string | null>(null);
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
    changesetVerified: card.changesetVerified,
    planContentHash: card.planContentHash,
  };

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDetailCard(null);
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [setDetailCard]);

  const handleAcceptDivergence = async (peerCardId: string) => {
    if (dismissingPeer) return;
    setDismissingPeer(peerCardId);
    try {
      await fetch("/api/coherence/dismiss", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cardId: card.id, otherCardId: peerCardId }),
      });
    } catch {
      // Best-effort; the heartbeat will re-detect if it wasn't dismissed.
    } finally {
      setDismissingPeer(null);
    }
  };

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
        cardTitle: card.title,
        projectName: card.project?.name,
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
  const reviewArtifact = artifacts.find(
    (a) => a.type === "review" && a.contentRef
  );
  const handoffArtifacts = [reviewArtifact, planArtifact].filter(
    (artifact): artifact is NonNullable<typeof artifact> => Boolean(artifact)
  );
  // Drop generic placeholders (e.g. stale "Thinking" rows) from the timeline.
  const visibleStatusHistory = statusHistory.filter(
    (entry) => !isGenericStatus(entry.message)
  );
  const showCurrentActivity = card.activity && !isGenericStatus(card.activity);
  const [filesExpanded, setFilesExpanded] = useState(fileChanges.length <= 12);
  const [reviewingFileIds, setReviewingFileIds] = useState<Set<string>>(new Set());
  const changesetReview = card.changesetReview;
  const reviewById = new Map(changesetReview?.files.map((file) => [file.id, file]) ?? []);
  const supportsFileReview =
    changesetReview?.capabilities.review === true && changesetReview.files.length > 0;
  const reviewedFileCount = changesetReview?.files.filter((file) => file.reviewed).length ?? 0;
  const remainingReviewFileIds =
    changesetReview?.files.filter((file) => !file.reviewed).map((file) => file.id) ?? [];

  const withReviewState = (
    review: ChangesetReview,
    sourceFiles: typeof fileChanges,
  ) => {
    const byId = new Map(review.files.map((file) => [file.id, file.reviewed]));
    return sourceFiles.map((file) =>
      file.id && byId.has(file.id) ? { ...file, reviewed: byId.get(file.id) } : file,
    );
  };

  const updateReviewState = async (fileIds: string[], reviewed: boolean) => {
    if (
      !hostUrl ||
      !changesetReview ||
      !changesetReview.capabilities.review ||
      fileIds.length === 0 ||
      fileIds.some((fileId) => !reviewById.has(fileId))
    ) {
      return;
    }

    const previousReview = changesetReview;
    const previousFiles = fileChanges;
    const optimisticReview: ChangesetReview = {
      ...changesetReview,
      files: changesetReview.files.map((file) =>
        fileIds.includes(file.id) ? { ...file, reviewed } : file,
      ),
    };

    setReviewingFileIds((current) => new Set([...current, ...fileIds]));
    updateCard(card.id, {
      changesetReview: optimisticReview,
      fileChanges: withReviewState(optimisticReview, fileChanges),
    });

    try {
      const response = await fetch("/api/ahp/sessions/review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hostUrl, sessionUri: card.id, files: fileIds, reviewed }),
      });
      const data = (await response.json().catch(() => null)) as
        | { ok?: boolean; review?: ChangesetReview }
        | null;

      // Always prefer the host's re-read, including a stale/racing response.
      if (data?.review) {
        reconcileCard(card.id, {
          changesetReview: data.review,
          fileChanges: withReviewState(data.review, fileChanges),
        });
      } else if (!response.ok || !data?.ok) {
        reconcileCard(card.id, {
          changesetReview: previousReview,
          fileChanges: previousFiles,
        });
      }
    } catch {
      reconcileCard(card.id, {
        changesetReview: previousReview,
        fileChanges: previousFiles,
      });
    } finally {
      setReviewingFileIds((current) => {
        const next = new Set(current);
        for (const fileId of fileIds) next.delete(fileId);
        return next;
      });
    }
  };

  return (
    <div className="absolute inset-0 z-modal-backdrop flex items-start justify-center">
      {/* Scrim */}
      <div
        ref={scrimRef}
        className="absolute inset-0 bg-black/10 backdrop-blur-[2px] animate-in fade-in duration-150"
        onClick={() => setDetailCard(null)}
      />

      {/* Modal */}
      <div className="absolute inset-4 z-modal grid grid-rows-[auto_1fr] overflow-hidden rounded-2xl border border-border bg-popover shadow-elevation-lg animate-in fade-in slide-in-from-bottom-2 duration-200">
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
              {card.gateStatus === "pending" && card.gateBlocker && (
                <span
                  className="inline-flex items-center gap-1 text-xs text-muted-foreground"
                  title={blockedFromAdvancingHint(card.gateBlocker)}
                >
                  <ShieldAlert className="h-3 w-3" />
                  {card.gateBlocker}
                </span>
              )}
              {card.manualOverride && (
                <span className="inline-flex items-center gap-1 text-xs text-amber-600" title="Manual override active">
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
              {card.model && (
                <Badge
                  variant="secondary"
                  className="h-5 gap-1 px-2 text-[11px]"
                  title="Selected model"
                >
                  <Cpu className="h-2.5 w-2.5" />
                  {card.model}
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
          handoffArtifacts.length > 0 && "md:grid-cols-[1.1fr_1px_0.9fr]"
        )}>
          {/* Left pane */}
          <ScrollArea className="min-h-0">
            <div className="flex flex-col gap-5 p-6">
              {/* Current Activity — always visible */}
              {showCurrentActivity && (
                <section>
                  <SectionLabel>
                    Current Activity
                  </SectionLabel>
                  <p className="text-[13px] leading-relaxed text-foreground/80">
                    {card.activity}
                  </p>
                </section>
              )}

              {/* Status history */}
              {visibleStatusHistory.length > 0 && (
                <section>
                  <SectionLabel>
                    Status history
                  </SectionLabel>
                  <div className="relative space-y-0.5 pl-1">
                    {[...visibleStatusHistory].reverse().map((entry, idx) => {
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
                            {idx < visibleStatusHistory.length - 1 && (
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
              <WorkerActivitySection key={card.id} card={card} />

              {/* Changed Files */}
              {fileChanges.length > 0 && (
                <section>
                  <div className="mb-2 flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setFilesExpanded(!filesExpanded)}
                      className={cn("flex min-w-0 flex-1 items-center gap-1 text-left hover:text-foreground transition-colors", SECTION_LABEL_CLASS)}
                    >
                      <ChevronDown className={cn("h-3 w-3 shrink-0 transition-transform", !filesExpanded && "-rotate-90")} />
                      Changed Files
                      <span className="ml-1 font-normal normal-case tabular-nums">({fileChanges.length})</span>
                      {supportsFileReview && (
                        <span className="ml-1 font-normal normal-case tabular-nums text-muted-foreground">
                          · {reviewedFileCount}/{changesetReview.files.length} reviewed
                        </span>
                      )}
                    </button>
                    {supportsFileReview && remainingReviewFileIds.length > 0 && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-6 shrink-0 px-2 text-[10px]"
                        disabled={!hostUrl || reviewingFileIds.size > 0}
                        title={!hostUrl ? "Connect to the agent host to update review progress" : undefined}
                        onClick={() => void updateReviewState(remainingReviewFileIds, true)}
                      >
                        Mark {remainingReviewFileIds.length} remaining
                      </Button>
                    )}
                  </div>
                  {filesExpanded && (
                    <div className="space-y-px rounded-lg border border-border/60 bg-muted/20 py-1">
                      {[...fileChanges]
                        .sort((a, b) => (b.added + b.removed) - (a.added + a.removed))
                        .map((file) => {
                          const display = shortenPath(file.path, card.project?.path ?? card.workingDirectory);
                          const hasStats = file.added > 0 || file.removed > 0;
                          return (
                            <div
                              key={file.id ?? file.path}
                              title={file.path}
                              className="group flex items-center gap-2 px-2.5 py-1 hover:bg-muted/50"
                            >
                              {supportsFileReview && file.id && reviewById.has(file.id) && (
                                <input
                                  type="checkbox"
                                  checked={reviewById.get(file.id)?.reviewed === true}
                                  disabled={!hostUrl || reviewingFileIds.size > 0}
                                  onChange={(event) => void updateReviewState([file.id!], event.target.checked)}
                                  aria-label={`Mark ${display.name} as reviewed`}
                                  className="h-3.5 w-3.5 shrink-0 accent-primary"
                                />
                              )}
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
                  <SectionLabel>
                    Last Response
                  </SectionLabel>
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

              {/* Coherence — board-level conflicts with other in-flight sessions */}
              {card.coherence && card.coherence.conflictsWith.length > 0 && (
                <section>
                  <SectionLabel className="flex items-center gap-1.5">
                    <Split className="h-3 w-3 text-purple-500" />
                    Coherence
                    {card.coherence.blocking && (
                      <span className="rounded bg-purple-100 px-1.5 py-0.5 text-[9px] font-medium text-purple-700 dark:bg-purple-900/40 dark:text-purple-300">
                        blocking ship
                      </span>
                    )}
                  </SectionLabel>
                  <div className="space-y-2">
                    {card.coherence.conflictsWith.map((peer) => (
                      <div
                        key={peer.cardId}
                        className="rounded-lg border border-purple-200 bg-purple-50/50 p-3 dark:border-purple-800 dark:bg-purple-950/20"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <button
                            onClick={() => setDetailCard(peer.cardId)}
                            className="truncate text-left text-xs font-medium text-foreground hover:text-primary hover:underline"
                          >
                            {peer.cardTitle}
                          </button>
                          <span className="shrink-0 rounded bg-purple-100 px-1.5 py-0.5 text-[9px] font-medium text-purple-700 dark:bg-purple-900/40 dark:text-purple-300">
                            {peer.tier === "file" ? "same file" : "same module"}
                          </span>
                        </div>
                        {peer.summary && (
                          <p className="mt-1 text-[11px] text-muted-foreground">{peer.summary}</p>
                        )}
                        {peer.findings && peer.findings.length > 0 && (
                          <ul className="mt-1.5 space-y-0.5">
                            {peer.findings.slice(0, 5).map((f, i) => (
                              <li key={i} className="flex gap-1 text-[11px] text-muted-foreground">
                                <span className="shrink-0">•</span>
                                <span>{f}</span>
                              </li>
                            ))}
                          </ul>
                        )}
                        {peer.overlapPaths && peer.overlapPaths.length > 0 && (
                          <p className="mt-1.5 truncate font-mono text-[10px] text-muted-foreground/70">
                            {peer.overlapPaths.slice(0, 3).join(", ")}
                          </p>
                        )}
                        <div className="mt-2">
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-6 text-[10px]"
                            disabled={dismissingPeer === peer.cardId}
                            onClick={() => void handleAcceptDivergence(peer.cardId)}
                          >
                            {dismissingPeer === peer.cardId ? "Accepting…" : "Accept divergence"}
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
              )}

              {/* Gates — real verdicts from the gate engine, with freshness */}
              {gateRuns.length > 0 && (
                <section>
                  <SectionLabel>
                    Gates
                  </SectionLabel>
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
                  <SectionLabel>
                    Review Findings
                  </SectionLabel>
                  <div className="space-y-2">
                    {card.reviewFindings.map((review) => {
                      const ReviewIcon =
                        review.status === "passed"
                          ? ShieldCheck
                          : review.status === "failed"
                            ? ShieldX
                            : review.status === "escalated"
                              ? AlertTriangle
                              : Loader2;

                      return (
                        <div
                          key={review.id}
                          className={cn(
                            "rounded-lg border border-border/70 bg-muted/15 p-3.5",
                            review.status === "failed" && "border-destructive/35 bg-destructive/[0.025]",
                            review.status === "escalated" && "border-pw-warning/55",
                            review.status === "in-progress" && "border-primary/25 bg-primary/[0.025]",
                          )}
                        >
                          <div className="flex items-center justify-between gap-3">
                            <span className="flex min-w-0 items-center gap-2 text-[13px] font-semibold">
                              <ReviewIcon
                                aria-hidden="true"
                                strokeWidth={1.8}
                                className={cn(
                                  "h-4 w-4 shrink-0",
                                  review.status === "passed" && "text-pw-success",
                                  review.status === "failed" && "text-destructive",
                                  review.status === "escalated" && "text-pw-warning",
                                  review.status === "in-progress" && "animate-spin text-primary",
                                )}
                              />
                              <span className="truncate">{review.skillId}</span>
                            </span>
                            <span className={cn(
                              "rounded-md px-2 py-1 text-[11px] font-semibold capitalize",
                              review.status === "passed" && "bg-pw-success/12 text-foreground",
                              review.status === "failed" && "bg-destructive/10 text-destructive",
                              review.status === "escalated" && "bg-pw-warning/15 text-foreground",
                              review.status === "in-progress" && "bg-primary/10 text-primary",
                            )}>
                              {review.status === "in-progress" ? `Reviewing (${review.iteration}/${review.maxIterations})` : review.status}
                            </span>
                          </div>
                          {review.summary && (
                            <p className="mt-1.5 text-xs leading-5 text-muted-foreground">{review.summary}</p>
                          )}
                          {review.findings && review.findings.length > 0 && (
                            <ul className="mt-1.5 space-y-0.5">
                              {review.findings.slice(0, 5).map((finding, i) => (
                                <li key={i} className="flex gap-1 text-[11px] text-muted-foreground">
                                  <span className="shrink-0">•</span>
                                  <span>{finding}</span>
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </section>
              )}

              {/* Pending Input */}
              {card.pendingInput && (
                <section>
                  <SectionLabel className="mb-2.5 text-amber-600 dark:text-amber-400">
                    Awaiting Input
                  </SectionLabel>
                  {/* Show last agent message as context when available */}
                  {card.lastAgentMessage && card.pendingInput?.kind !== "toolAuthentication" && (
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

              {/* Supporting artifacts */}
              {artifacts.filter((a) => a.type !== "plan" && a.type !== "review").length > 0 && (
                <section>
                  <SectionLabel>
                    Artifacts
                  </SectionLabel>
                  <div className="space-y-1">
                    {artifacts
                      .filter((a) => a.type !== "plan" && a.type !== "review")
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

          {/* Divider + intent/review handoff pane */}
          {handoffArtifacts.length > 0 && (
            <>
              <div className="hidden bg-border/60 md:block" />
              <ScrollArea className="hidden min-h-0 md:block">
                <div className="p-6">
                  <div className="space-y-8">
                    {handoffArtifacts.map((artifact) => {
                      const Icon = artifactIcons[artifact.type];
                      const isPlan = artifact.type === "plan";
                      return (
                        <section key={artifact.id}>
                          <div className="mb-4 flex items-center gap-2">
                            <div className="flex h-6 w-6 items-center justify-center rounded-md bg-primary/10">
                              <Icon className="h-3.5 w-3.5 text-primary" />
                            </div>
                            <h3 className="text-sm font-semibold">
                              {isPlan ? "Original intent" : artifact.title}
                            </h3>
                          </div>
                          <article className="prose prose-sm dark:prose-invert max-w-none prose-headings:font-semibold prose-h1:text-base prose-h2:text-sm prose-h2:mt-5 prose-h2:mb-2 prose-h3:text-xs prose-p:text-[13px] prose-p:leading-relaxed prose-li:text-[13px] prose-table:text-xs prose-pre:bg-muted prose-pre:border prose-pre:border-border prose-code:text-[12px] prose-strong:font-semibold">
                            <ReactMarkdown
                              remarkPlugins={[remarkGfm]}
                              components={markdownComponents}
                            >
                              {artifact.contentRef!}
                            </ReactMarkdown>
                          </article>
                        </section>
                      );
                    })}
                  </div>
                </div>
              </ScrollArea>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
