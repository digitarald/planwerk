"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  X,
  Send,
  GitBranch,
  FileText,
  FlaskConical,
  Lightbulb,
  BookOpen,
  ClipboardCheck,
  Scale,
  Wrench,
  Bot,
  Shield,
  ShieldAlert,
  Loader2,
  CirclePause,
  AlertTriangle,
  ShieldCheck,
  ShieldX,
  MessageCircleWarning,
  XCircle,
} from "lucide-react";

import { PendingInputCard } from "./pending-input-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import { useBoardStore } from "@/lib/store/board-store";
import { useOrchestratorStore } from "@/lib/store/orchestrator-store";
import {
  KanbanCard,
  Artifact,
  ArtifactType,
  ActivityEntry,
  RiskLevel,
  RuntimeStatus,
  GateStatus,
} from "@/lib/types";
import { cn } from "@/lib/utils";

const artifactIcons: Record<ArtifactType, typeof FileText> = {
  plan: FileText,
  research: FlaskConical,
  design: Lightbulb,
  spec: BookOpen,
  "test-plan": ClipboardCheck,
  decision: Scale,
};

const activityIcons: Record<ActivityEntry["type"], typeof Wrench> = {
  tool: Wrench,
  agent: Bot,
  gate: Shield,
};

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
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
  const [message, setMessage] = useState("");
  const scrimRef = useRef<HTMLDivElement>(null);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDetailCard(null);
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [setDetailCard]);

  const handleInject = (e: React.FormEvent) => {
    e.preventDefault();
    if (!message.trim()) return;
    addFeedItem({
      type: "intervention",
      message: `Message sent to "${card.title}": "${message.trim()}"`,
      cardId: card.id,
    });
    setMessage("");
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleInject(e);
    }
  };

  const artifacts = card.artifacts ?? [];
  const recentActivity = card.recentActivity ?? [];
  const planArtifact = artifacts.find(
    (a) => a.type === "plan" && a.contentRef
  );

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

              {/* Recent Activity */}
              {recentActivity.length > 0 && (
                <section>
                  <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
                    Recent Activity
                  </h3>
                  <div className="space-y-1">
                    {recentActivity.map((entry, idx) => {
                      const Icon = activityIcons[entry.type];
                      return (
                        <div
                          key={idx}
                          className="flex items-start gap-2.5 py-1.5 text-sm"
                        >
                          <div className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded bg-muted">
                            <Icon className="h-3 w-3 text-muted-foreground" />
                          </div>
                          <span className="min-w-0 flex-1 text-[13px] leading-relaxed text-foreground/80">
                            {entry.message}
                          </span>
                          <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground/60">
                            {formatTime(entry.timestamp)}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </section>
              )}

              {/* Last Agent Message */}
              {card.lastAgentMessage && (
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

              {/* Pending Input */}
              {card.pendingInput && (
                <section>
                  <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
                    Awaiting Input
                  </h3>
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
                    className="min-h-[3rem] resize-none pr-10 text-[13px]"
                    rows={2}
                  />
                  <Button
                    type="submit"
                    size="icon-sm"
                    variant="ghost"
                    disabled={!message.trim()}
                    className="absolute bottom-2 right-2"
                  >
                    <Send className="h-3.5 w-3.5" />
                  </Button>
                </form>
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
