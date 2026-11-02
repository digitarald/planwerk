"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  X,
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
  RotateCcw,
} from "lucide-react";

import { ConversationControls } from "./conversation-controls";
import { requestEvidenceRefresh } from "@/lib/ahp/evidence-request";
import { SessionEvidencePanel } from "./session-evidence-panel";
import { SessionOwnershipRecovery } from "./session-ownership-recovery";

import { PendingInputCard } from "./pending-input-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
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
  type SessionDetails,
  isGateRunStale,
} from "@/lib/types";
import type { ChangesetReview } from "@/lib/types";
import { GatePipeline } from "@/components/gates/gate-pipeline";
import { SessionCoordinatorModeControl } from "@/components/orchestrator/coordinator-mode-control";
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

const SECTION_LABEL_CLASS =
  "text-sm font-semibold leading-5 text-foreground";
const DETAIL_PROSE_CLASS =
  "prose prose-sm dark:prose-invert w-full max-w-[72ch] break-words text-base leading-7 sm:text-sm sm:leading-6 prose-headings:font-semibold prose-h1:text-xl prose-h2:text-lg prose-h3:text-base prose-pre:max-w-full prose-pre:bg-muted prose-code:text-[0.9em]";
const DISCLOSURE_CLASS =
  "min-h-9 cursor-pointer content-center rounded-sm text-sm font-medium text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

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
  if (worker.usage?.inputTokens === undefined || worker.usage.outputTokens === undefined) return undefined;
  return worker.usage.inputTokens + worker.usage.outputTokens;
}

function ChatFactsSection({ card }: { card: KanbanCard }) {
  const chats = card.chats?.filter((chat) => chat.interactivity !== "hidden") ?? [];
  const background = card.backgroundWork ?? [];
  if (chats.length === 0 && background.length === 0) return null;
  return (
    <section className="space-y-3">
      {chats.length > 0 && <details>
        <summary className={DISCLOSURE_CLASS}>Chats ({chats.length})</summary>
        <div className="mt-3 divide-y divide-border/60">
          {chats.map((chat) => <div key={chat.resource} className="py-3 text-xs">
            <div className="flex justify-between gap-2">
              <span className="font-medium">{chat.title}</span>
              <span className="text-muted-foreground">
                {chat.resource === card.defaultChat && "Default · "}
                {chat.interactivity === "read-only" ? "Read only" : chat.status === undefined ? "Status unknown" :
                  (chat.status & 64) !== 0 ? "Archived" : (chat.status & 2) !== 0 ? "Error" : (chat.status & 24) === 24 ? "Needs input" : (chat.status & 8) !== 0 ? "Working" : "Idle"}
              </span>
            </div>
            {chat.status !== undefined && <p className="mt-1 text-muted-foreground">{(chat.status & 32) !== 0 ? "Read" : "Unread"}</p>}
            {chat.changes && <p className="mt-1 text-muted-foreground">
              {chat.changes.files !== undefined && `${chat.changes.files} files · `}
              {chat.changes.additions !== undefined && `+${chat.changes.additions} `}
              {chat.changes.deletions !== undefined && `−${chat.changes.deletions}`}
            </p>}
          </div>)}
        </div>
      </details>}
      {background.length > 0 && <div>
        <SectionLabel>Background work</SectionLabel>
        {background.map(({ chat, work }) => <div key={`${chat}:${work.id}`} className="flex items-center gap-2 py-1 text-xs">
          <Loader2 aria-hidden="true" className="h-3 w-3 animate-spin" />
          <span>{work.label}</span><span className="text-muted-foreground">{work.kind === "shell" ? "Shell" : work.kind === "subagent" ? "Subagent" : "Background task"} · {new Date(work.startedAt).toLocaleTimeString()}</span>
        </div>)}
      </div>}
    </section>
  );
}

function WorkerActivitySection({ card }: { card: KanbanCard }) {
  const workers = card.workers;
  const [completedExpanded, setCompletedExpanded] = useState(false);
  if (!workers || workers.length === 0) return null;

  const foregroundWorkers = workers.filter(
    (worker) => worker.isActive || worker.runtime !== "idle",
  );
  const activeWorkerCount = workers.filter((worker) => worker.isActive).length;
  const attentionWorkerCount = foregroundWorkers.filter((worker) => worker.runtime === "input-needed" || worker.runtime === "error").length;
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
                    title={`Loaded-turn subtotal, not lifetime usage or context occupancy${worker.usage.observedAt ? `; observed ${worker.usage.observedAt}` : ""}`}
                  >
                    {worker.usage.inputTokens !== undefined && `${formatTokenCount(worker.usage.inputTokens)} in`}
                    {worker.usage.inputTokens !== undefined && worker.usage.outputTokens !== undefined && " · "}
                    {worker.usage.outputTokens !== undefined && `${formatTokenCount(worker.usage.outputTokens)} out`}
                    {worker.usage.cacheReadTokens !== undefined && ` · ${formatTokenCount(worker.usage.cacheReadTokens)} cached`}
                    {" · loaded turns"}
                    {worker.usage.partial && " · partial"}
                    {!!worker.usage.models?.length && ` · ${worker.usage.models.join(", ")}`}
                  </p>
                )}
                {!worker.usage && <p className="mt-2 text-[11px] text-muted-foreground">Usage unavailable</p>}
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
  const reconcileCard = useBoardStore((s) => s.reconcileCard);
  const addFeedItem = useOrchestratorStore((s) => s.addFeedItem);
  const hostUrl = useConnectionStore((s) => s.hostUrl);
  const ownershipBlocked = card.ownershipConflict || card.automationWait?.reason === "ownership";
  const [detailsResult, setDetailsResult] = useState<{
    cardId: string;
    state: "ready" | "error";
    details?: SessionDetails;
    error?: string;
  } | null>(null);
  const [resumeState, setResumeState] = useState<
    "idle" | "resuming" | "error"
  >("idle");
  const [resumeError, setResumeError] = useState("");
  const evidenceKey = JSON.stringify([hostUrl, card.id]);
  const [evidenceResult, setEvidenceResult] = useState<{
    key: string;
    state: "refreshing" | "ready" | "error";
    error?: string;
  } | null>(null);
  const evidenceState = evidenceResult?.key === evidenceKey ? evidenceResult.state : "idle";
  const evidenceError = evidenceResult?.key === evidenceKey ? evidenceResult.error : undefined;
  const evidenceRequest = useRef<AbortController | null>(null);
  const detailsRequest = useRef<AbortController | null>(null);
  const [dismissingPeer, setDismissingPeer] = useState<string | null>(null);
  const [statusHistory, setStatusHistory] = useState<StatusEntry[]>(
    card.statusHistory ?? []
  );
  const titleRef = useRef<HTMLHeadingElement>(null);
  const reviewRequest = useRef<AbortController | null>(null);
  const [reviewError, setReviewError] = useState("");
  const [reviewRetry, setReviewRetry] = useState<{ fileIds: string[]; reviewed: boolean } | null>(null);

  useEffect(() => () => {
    reviewRequest.current?.abort();
    reviewRequest.current = null;
  }, [card.id, hostUrl]);

  useEffect(() => {
    return () => {
      evidenceRequest.current?.abort();
      evidenceRequest.current = null;
    };
  }, [card.id, hostUrl]);

  const refreshEvidence = async () => {
    if (!hostUrl || card.ownershipConflict || evidenceRequest.current) return;
    const controller = new AbortController();
    evidenceRequest.current = controller;
    detailsRequest.current?.abort();
    setEvidenceResult({ key: evidenceKey, state: "refreshing" });
    try {
      await requestEvidenceRefresh(hostUrl, card.id, controller.signal);
      if (controller.signal.aborted || evidenceRequest.current !== controller) return;
      // Current facts arrive over the ordered stream, never a racing HTTP patch.
      setEvidenceResult({ key: evidenceKey, state: "ready" });
    } catch (error) {
      if (controller.signal.aborted || evidenceRequest.current !== controller) return;
      setDetailsResult({
        cardId: card.id, state: "error",
        error: error instanceof Error ? error.message : "Evidence refresh failed",
      });
      setEvidenceResult({
        key: evidenceKey, state: "error",
        error: error instanceof Error ? error.message : "Evidence refresh failed",
      });
    } finally {
      if (evidenceRequest.current === controller) evidenceRequest.current = null;
    }
  };

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

  useEffect(() => {
    let cancelled = false;

    if (!hostUrl || card.ownershipConflict) {
      return;
    }
    const controller = new AbortController();
    detailsRequest.current = controller;
    const observed = useBoardStore.getState().getCard(card.id);

    fetch("/api/ahp/sessions/details", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hostUrl, sessionUri: card.id }),
      signal: controller.signal,
    })
      .then(async (response) => {
        const data = (await response.json().catch(() => null)) as
          | { details?: SessionDetails; error?: string }
          | null;
        if (!response.ok || !data?.details) {
          throw new Error(data?.error || "Failed to read session details");
        }
        return data.details;
      })
      .then((details) => {
        if (cancelled || controller.signal.aborted) return;
        const current = useBoardStore.getState().getCard(card.id);
        if (!current || current !== observed) {
          if (current) setDetailsResult({
            cardId: card.id, state: "ready",
            details: { lastAgentMessage: current.lastAgentMessage, runtimeError: current.runtimeError },
          });
          return;
        }
        setDetailsResult({
          cardId: card.id,
          state: "ready",
          details,
        });
        reconcileCard(card.id, {
          lastAgentMessage: details.lastAgentMessage,
          runtimeError: details.runtimeError,
        });
      })
      .catch((error: unknown) => {
        if (cancelled || controller.signal.aborted) return;
        setDetailsResult({
          cardId: card.id,
          state: "error",
          error:
            error instanceof Error
              ? error.message
              : "Failed to read session details",
        });
      });

    return () => {
      cancelled = true;
      controller.abort();
      if (detailsRequest.current === controller) detailsRequest.current = null;
    };
  }, [
    card.id,
    card.ownershipConflict,
    hostUrl,
    reconcileCard,
  ]);

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

  const handleResume = async () => {
    const currentDetails =
      detailsResult?.cardId === card.id
        ? detailsResult.details
        : undefined;
    const runtimeError =
      currentDetails?.runtimeError ?? card.runtimeError;
    if (
      !hostUrl ||
      !runtimeError?.resumable ||
      !runtimeError.chatUri ||
      !runtimeError.turnId ||
      resumeState === "resuming"
    ) {
      return;
    }

    setResumeState("resuming");
    setResumeError("");
    try {
      const response = await fetch("/api/ahp/sessions/resume", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          hostUrl,
          sessionUri: card.id,
          chatUri: runtimeError.chatUri,
          turnId: runtimeError.turnId,
        }),
      });
      const data = (await response.json().catch(() => null)) as
        | { details?: SessionDetails; error?: string }
        | null;
      if (data?.details) {
        setDetailsResult({
          cardId: card.id,
          state: "ready",
          details: data.details,
        });
        reconcileCard(card.id, {
          lastAgentMessage: data.details.lastAgentMessage,
          runtimeError: data.details.runtimeError,
        });
      }
      if (!response.ok) {
        throw new Error(data?.error || "Failed to resume the session");
      }
      addFeedItem({
        type: "intervention",
        message: `Resumed the failed turn in "${card.title}".`,
        cardId: card.id,
        cardTitle: card.title,
        projectName: card.project?.name,
      });
      setResumeState("idle");
    } catch (error) {
      setResumeError(
        error instanceof Error ? error.message : "Failed to resume the session",
      );
      setResumeState("error");
    }
  };

  const artifacts = card.artifacts ?? [];
  const fileChanges = card.fileChanges ?? [];
  const chatsWithChanges = card.chats?.filter(
    (chat) => chat.interactivity !== "hidden" && card.chatDetails?.[chat.resource]?.changesets.length,
  ) ?? [];
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
  const currentDetailsResult =
    detailsResult?.cardId === card.id ? detailsResult : undefined;
  const needsAuthoritativeDetails = Boolean(hostUrl) && !card.ownershipConflict;
  const detailsState =
    (evidenceState === "ready" ? "ready" : currentDetailsResult?.state) ??
    (needsAuthoritativeDetails ? "loading" : "idle");
  const detailsError = currentDetailsResult?.error ?? "";
  const sessionDetails =
    (evidenceState === "ready" ? undefined : currentDetailsResult?.details) ?? {
      lastAgentMessage: card.lastAgentMessage,
      runtimeError: card.runtimeError,
    };
  const effectiveLastAgentMessage =
    detailsState === "ready"
      ? sessionDetails.lastAgentMessage
      : sessionDetails.lastAgentMessage ?? card.lastAgentMessage;
  const effectiveRuntimeError =
    detailsState === "ready"
      ? sessionDetails.runtimeError
      : sessionDetails.runtimeError ?? card.runtimeError;
  const [reviewing, setReviewing] = useState(false);
  const changesetReview = card.changesetReview;
  const reviewById = new Map(changesetReview?.files.map((file) => [file.id, file]) ?? []);
  const supportsFileReview = !ownershipBlocked &&
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
    if (reviewRequest.current) return;
    if (
      !hostUrl ||
      ownershipBlocked ||
      !changesetReview ||
      !changesetReview.capabilities.review ||
      fileIds.length === 0 ||
      fileIds.some((fileId) => !reviewById.has(fileId))
    ) {
      setReviewError("Review progress is unavailable or the files changed. Refresh evidence before trying again.");
      return;
    }

    const controller = new AbortController();
    reviewRequest.current = controller;
    setReviewError("");
    setReviewRetry({ fileIds, reviewed });
    setReviewing(true);

    try {
      const response = await fetch("/api/ahp/sessions/review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hostUrl, sessionUri: card.id, files: fileIds, reviewed }),
        signal: controller.signal,
      });
      const data = (await response.json().catch(() => null)) as
        | { ok?: boolean; review?: ChangesetReview; error?: string }
        | null;

      if (controller.signal.aborted) return;
      if (data?.review) {
        const currentFiles = useBoardStore.getState().getCard(card.id)?.fileChanges ?? [];
        reconcileCard(card.id, {
          changesetReview: data.review,
          fileChanges: withReviewState(data.review, currentFiles),
        });
      }
      if (!response.ok || !data?.ok || !data.review) {
        throw new Error(data?.error || "The host did not confirm the review update. Refresh evidence to check its current state.");
      }
      setReviewRetry(null);
    } catch (error) {
      if (!controller.signal.aborted) {
        setReviewError(error instanceof Error ? error.message : "The review update was not confirmed. Refresh evidence before retrying.");
      }
    } finally {
      if (!reviewRequest.current || reviewRequest.current === controller) {
        reviewRequest.current = null;
        setReviewing(false);
      }
    }
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open) setDetailCard(null); }}>
      <DialogContent
        showCloseButton={false}
        initialFocus={titleRef}
        className="inset-2 grid w-auto max-w-none translate-x-0 translate-y-0 grid-rows-[auto_minmax(0,1fr)_auto] gap-0 overflow-hidden rounded-xl p-0 shadow-elevation-lg sm:inset-4 sm:max-w-none"
      >
        {/* Header */}
        <div className="flex max-h-[35dvh] items-start gap-3 overflow-y-auto border-b border-border/60 p-4 sm:px-6">
          <div className="min-w-0 flex-1">
            <DialogTitle ref={titleRef} tabIndex={-1} className="break-words text-lg font-semibold leading-tight tracking-tight outline-none">
              {card.title}
            </DialogTitle>
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5">
              <RuntimeBadge status={card.runtime} />
              <RiskBadge level={card.risk} />
              {card.riskFactors && card.riskFactors.length > 0 && (
                <span className="text-xs text-muted-foreground">
                  {card.riskFactors.join(" · ")}
                </span>
              )}
              <GateBadge status={card.gateStatus} />
              {card.gateStatus === "pending" && card.gateBlocker && !card.automationWait && (
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
            <div className="mt-3 flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
              <GatePipeline
                cardId={card.id}
                currentPhase={card.phase}
                gateStatus={card.gateStatus}
                runtime={card.runtime}
                runs={gateRuns}
                cardDiff={cardDiff}
              />
              <SessionCoordinatorModeControl
                cardId={card.id}
                cardTitle={card.title}
              />
            </div>
          </div>
          <DialogClose render={<Button variant="ghost" size="icon" className="shrink-0" />}>
            <X className="h-4 w-4" />
            <span className="sr-only">Close</span>
          </DialogClose>
        </div>

        <ScrollArea className="min-h-0 min-w-0">
        <div className={cn(
          "grid grid-cols-1",
          handoffArtifacts.length > 0 && "lg:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)]"
        )}>
          {/* Left pane */}
          <div className="flex min-w-0 flex-col gap-6 p-4 sm:p-6">
              {effectiveRuntimeError && (
                <section
                  aria-live="polite"
                  className="rounded-lg border border-destructive/35 bg-destructive/[0.035] p-4"
                >
                  <div className="flex items-start gap-3">
                    <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <SectionLabel className="mb-0 text-destructive">
                          Runtime error
                        </SectionLabel>
                        {effectiveRuntimeError.resumable &&
                          effectiveRuntimeError.chatUri &&
                          effectiveRuntimeError.turnId && (
                            <Button
                              type="button"
                              size="sm"
                              variant="destructive"
                              onClick={handleResume}
                              disabled={ownershipBlocked || resumeState === "resuming"}
                            >
                              <RotateCcw
                                className={cn(
                                  "h-3.5 w-3.5",
                                  resumeState === "resuming" && "animate-spin",
                                )}
                              />
                              {resumeState === "resuming" ? "Resuming" : "Resume turn"}
                            </Button>
                          )}
                      </div>
                      <p className="mt-2 max-w-[75ch] text-[13px] leading-relaxed text-foreground">
                        {effectiveRuntimeError.message}
                      </p>
                      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                        <span>{effectiveRuntimeError.errorType}</span>
                        {effectiveRuntimeError.startedAt && (
                          <span>
                            {new Date(effectiveRuntimeError.startedAt).toLocaleString()}
                          </span>
                        )}
                        <span>
                          {effectiveRuntimeError.source === "turn"
                            ? "Agent turn failed"
                            : "Session creation failed"}
                        </span>
                      </div>
                      {effectiveRuntimeError.stack && (
                        <details className="mt-3">
                          <summary className="cursor-pointer text-xs font-medium text-muted-foreground hover:text-foreground">
                            Technical details
                          </summary>
                          <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded-md bg-muted/60 p-3 font-mono text-[11px] leading-relaxed text-foreground/80">
                            {effectiveRuntimeError.stack}
                          </pre>
                        </details>
                      )}
                      {resumeState === "error" && (
                        <p className="mt-3 text-xs font-medium text-destructive">
                          {resumeError}
                        </p>
                      )}
                    </div>
                  </div>
                </section>
              )}

              {card.runtime === "error" &&
                !effectiveRuntimeError &&
                detailsState === "loading" && (
                  <section
                    aria-live="polite"
                    className="rounded-lg border border-destructive/25 bg-destructive/[0.025] p-4"
                  >
                    <div className="flex items-center gap-3 text-sm text-muted-foreground">
                      <Loader2 className="h-4 w-4 animate-spin text-destructive" />
                      Reading the failed turn from the agent host...
                    </div>
                  </section>
                )}

              {card.runtime === "error" &&
                !effectiveRuntimeError &&
                detailsState === "error" && (
                  <section className="rounded-lg border border-destructive/35 bg-destructive/[0.035] p-4">
                    <div className="flex items-start gap-3">
                      <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                      <div>
                        <SectionLabel className="mb-1 text-destructive">
                          Error details unavailable
                        </SectionLabel>
                        <p className="text-[13px] leading-relaxed text-foreground/80">
                          {detailsError}
                        </p>
                      </div>
                    </div>
                  </section>
                )}

              {card.runtime === "error" &&
                !effectiveRuntimeError &&
                detailsState === "ready" && (
                  <section className="rounded-lg border border-border bg-muted/20 p-4">
                    <div className="flex items-start gap-3">
                      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-pw-warning" />
                      <div>
                        <SectionLabel className="mb-1">
                          Error details unavailable
                        </SectionLabel>
                        <p className="text-[13px] leading-relaxed text-foreground/80">
                          The agent host reports an error but did not expose a detailed failure for the latest turn.
                        </p>
                      </div>
                    </div>
                  </section>
                )}

              {card.pendingInput && (
                <section aria-label="Awaiting input">
                  <SectionLabel className="text-pw-warning-foreground">
                    Awaiting input
                  </SectionLabel>
                  {effectiveLastAgentMessage && card.pendingInput.kind !== "toolAuthentication" && (
                    <details className="mb-4" open={effectiveLastAgentMessage.length <= 500 || undefined}>
                      <summary className={DISCLOSURE_CLASS}>Read agent response</summary>
                      <article className={cn(DETAIL_PROSE_CLASS, "mt-3")}>
                        <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                          {effectiveLastAgentMessage}
                        </ReactMarkdown>
                      </article>
                    </details>
                  )}
                  <div className="@container/col [&_button]:min-h-11 [&_button]:text-sm [&_input]:text-base [&_p]:text-sm [&_p]:leading-6 [&_textarea]:text-base">
                    <PendingInputCard cardId={card.id} input={card.pendingInput} />
                  </div>
                </section>
              )}

              {effectiveLastAgentMessage && !card.pendingInput && (
                <section aria-label="Last response">
                  <SectionLabel>Last response</SectionLabel>
                  <article className={DETAIL_PROSE_CLASS}>
                    <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                      {effectiveLastAgentMessage}
                    </ReactMarkdown>
                  </article>
                </section>
              )}

              {!effectiveLastAgentMessage && !card.pendingInput && card.runtime !== "error" && (
                <section aria-live="polite">
                  <SectionLabel>Last response</SectionLabel>
                  {detailsState === "loading" ? (
                    <p className="text-sm text-muted-foreground">Reading the latest response…</p>
                  ) : detailsState === "error" ? (
                    <p className="text-sm text-destructive">{detailsError}</p>
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      {detailsState === "ready"
                        ? "The agent host did not expose a final response for this session."
                        : "No captured response is available."}
                    </p>
                  )}
                </section>
              )}

              {showCurrentActivity && (
                <section>
                  <SectionLabel>
                    Current Activity
                  </SectionLabel>
                  <p className="max-w-[72ch] text-sm leading-6 text-foreground">
                    {card.activity}
                  </p>
                </section>
              )}

              <SessionEvidencePanel
                card={card} connected={Boolean(hostUrl)}
                refreshState={evidenceState} refreshError={evidenceError}
                onRefresh={refreshEvidence}
                ownershipRecovery={card.ownershipConflict ? <SessionOwnershipRecovery key={evidenceKey} sessionUri={card.id} /> : undefined}
              />

              {visibleStatusHistory.length > 0 && (
                <details>
                  <summary className={DISCLOSURE_CLASS}>Status history ({visibleStatusHistory.length})</summary>
                  <div className="relative mt-3 space-y-0.5 pl-1">
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
                </details>
              )}
              <ChatFactsSection card={card} />
              <WorkerActivitySection key={card.id} card={card} />

              {/* Changed Files */}
              {(fileChanges.length > 0 || chatsWithChanges.length > 0) && (
                <section aria-label="Changes">
                  <details>
                    <summary className={DISCLOSURE_CLASS}>Changes</summary>
                    <div className="space-y-4 pt-3">
                      {fileChanges.length > 0 && (
                        <div>
                          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                            <h4 className="text-xs font-medium text-muted-foreground">
                              Session changes ({fileChanges.length})
                              {supportsFileReview && ` · ${reviewedFileCount}/${changesetReview.files.length} reviewed`}
                            </h4>
                            {supportsFileReview && remainingReviewFileIds.length > 0 && (
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                disabled={!hostUrl || reviewing}
                                title={!hostUrl ? "Connect to the agent host to update review progress" : undefined}
                                onClick={() => void updateReviewState(remainingReviewFileIds, true)}
                              >
                                Mark {remainingReviewFileIds.length} remaining
                              </Button>
                            )}
                          </div>
                          <div className="space-y-px rounded-lg border border-border/60 bg-muted/20 py-1">
                            {[...fileChanges]
                              .sort((a, b) => (b.added + b.removed) - (a.added + a.removed))
                              .map((file) => {
                                const display = shortenPath(file.path, card.project?.path ?? card.workingDirectory);
                                const review = file.id ? reviewById.get(file.id) : undefined;
                                const hasStats = file.added > 0 || file.removed > 0;
                                return (
                                  <div
                                    key={file.id ?? file.path}
                                    title={file.path}
                                    className="group flex items-center gap-2 px-2.5 py-1 hover:bg-muted/50"
                                  >
                                    {supportsFileReview && review && (
                                      <input
                                        type="checkbox"
                                        checked={review.reviewed}
                                        disabled={!hostUrl || reviewing}
                                        onChange={(event) => void updateReviewState([review.id], event.target.checked)}
                                        aria-label={`Mark ${display.name} as reviewed`}
                                        className="h-5 w-5 shrink-0 accent-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                                      />
                                    )}
                                    <FilePen className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />
                                    <span className="min-w-0 flex-1 truncate text-[12px] font-mono">
                                      <span className="text-foreground">{display.name}</span>
                                      {display.dir && (
                                        <span className="ml-1.5 text-muted-foreground">{display.dir}</span>
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
                        </div>
                      )}
                      {chatsWithChanges.map((chat) => (
                        <div key={chat.resource}>
                          <h4 className="mb-2 text-xs font-medium">{chat.title}</h4>
                          {card.chatDetails?.[chat.resource]?.changesets.map((changeset) => (
                            <details key={changeset.resource} className="border-t border-border/60 py-2">
                              <summary className={DISCLOSURE_CLASS}>
                                {changeset.label} · {changeset.status}{changeset.files && ` · ${changeset.files.length} files`}
                              </summary>
                              <div className="mt-2 space-y-1">
                                {changeset.files?.map((file) => (
                                  <p key={file.id} className="flex min-w-0 justify-between gap-3 text-xs" title={file.path}>
                                    <span className="truncate">{file.path}</span>
                                    <span className="shrink-0 tabular-nums text-muted-foreground">+{file.added} −{file.removed}</span>
                                  </p>
                                ))}
                              </div>
                            </details>
                          ))}
                        </div>
                      ))}
                    </div>
                  </details>
                  {reviewError && (
                    <div className="mt-3 space-y-2">
                      <p role="alert" className="text-sm text-destructive">{reviewError}</p>
                      {reviewRetry && (
                        <Button variant="outline" size="sm" disabled={!hostUrl || !supportsFileReview || reviewing}
                          onClick={() => void updateReviewState(reviewRetry.fileIds, reviewRetry.reviewed)}>
                          Retry review update
                        </Button>
                      )}
                    </div>
                  )}
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

          </div>

          {handoffArtifacts.length > 0 && (
              <aside aria-label="Plan and review" className="min-w-0 space-y-8 border-t border-border/60 p-4 sm:p-6 lg:border-t-0 lg:border-l">
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
                          <article className={DETAIL_PROSE_CLASS}>
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
              </aside>
          )}
        </div>
        </ScrollArea>
        <div className="max-h-[35dvh] overflow-y-auto border-t border-border/60 px-4 py-3 sm:px-6">
          <ConversationControls key={`${hostUrl}:${card.id}`} card={card} hostUrl={hostUrl} onSent={(text, outcome) => addFeedItem({
            type: "intervention",
            message: `Message ${outcome === "queued" ? "queued for" : outcome === "steering-pending" ? "submitted as steering to" : "accepted by"} "${card.title}": "${text}"`,
            cardId: card.id, cardTitle: card.title, projectName: card.project?.name,
          })} />
        </div>
      </DialogContent>
    </Dialog>
  );
}
