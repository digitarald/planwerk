"use client";

import { useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  BookOpenCheck,
  CheckCircle2,
  ChevronDown,
  CircleDot,
  Clock3,
  FileCheck2,
  Loader2,
  Mail,
  MailOpen,
  MessageCircleQuestion,
  Pin,
  PinOff,
  ShieldCheck,
  Sparkles,
} from "lucide-react";

import { ArtifactViewer } from "@/components/board/artifact-viewer";
import { Button } from "@/components/ui/button";
import { routeInboxClientAction } from "@/lib/inbox/client-action-routing";
import { useBoardStore } from "@/lib/store/board-store";
import {
  useInboxStore,
  type InboxItem,
  type InboxSuggestedAction,
} from "@/lib/store/inbox-store";
import type { Artifact, ArtifactType } from "@/lib/types";
import { useUIStore } from "@/lib/store/ui-store";
import { cn } from "@/lib/utils";

const sourceIcons: Record<string, typeof CircleDot> = {
  "pending-input": MessageCircleQuestion,
  approval: ShieldCheck,
  "runtime-error": AlertTriangle,
  "gate-failure": AlertTriangle,
  "review-ready": BookOpenCheck,
  "ship-ready": CheckCircle2,
  conflict: AlertTriangle,
  completion: CheckCircle2,
  "review-escalation": ShieldCheck,
  "coordinator-action": ShieldCheck,
};

const sourceLabels: Record<string, string> = {
  "pending-input": "Needs reply",
  approval: "Needs approval",
  "runtime-error": "Error",
  "gate-failure": "Check failed",
  "review-ready": "Ready to review",
  "ship-ready": "Ready to ship",
  conflict: "Conflict",
  completion: "Finished",
  "review-escalation": "Review blocked",
  "coordinator-action": "Coordinator update",
};

const artifactLabels: Record<ArtifactType, string> = {
  plan: "Plan",
  review: "Review",
  research: "Research",
  design: "Design",
  spec: "Spec",
  "test-plan": "Test plan",
  decision: "Decision",
};

const artifactIcons: Record<ArtifactType, typeof FileCheck2> = {
  plan: FileCheck2,
  review: BookOpenCheck,
  research: FileCheck2,
  design: FileCheck2,
  spec: FileCheck2,
  "test-plan": FileCheck2,
  decision: ShieldCheck,
};

function relativeTime(timestamp: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 60) return "now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function formattedTime(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(timestamp);
}

function actionLabel(item: InboxItem, action: InboxSuggestedAction): string {
  if (item.briefing.synthesisStatus === "generated") return action.label;
  if (
    item.briefing.trigger === "wip-violation" &&
    action.kind !== "resolve"
  ) {
    return "Open board";
  }
  if (action.kind === "resolve") return "Done";
  if (action.kind === "mark-read") return "Read";

  switch (item.sourceKind) {
    case "pending-input":
      return "Reply";
    case "approval":
    case "review-ready":
    case "review-escalation":
    case "ship-ready":
      return "Review";
    case "runtime-error":
    case "gate-failure":
    case "conflict":
      return "Inspect";
    case "completion":
      return "Read";
    default:
      return action.kind === "open-session" ? "Open" : action.label;
  }
}

function confidenceNote(item: InboxItem): string | null {
  if (item.briefing.freshness.stale) return "This summary may be out of date.";
  if (item.briefing.confidence === "low") return "The recommendation is uncertain.";
  return null;
}

export function InboxFeedItem({
  item,
  projectName,
  selected,
}: {
  item: InboxItem;
  projectName?: string;
  selected: boolean;
}) {
  const articleRef = useRef<HTMLElement>(null);
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const [artifact, setArtifact] = useState<Artifact | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const selectItem = useInboxStore((state) => state.selectItem);
  const mutateItem = useInboxStore((state) => state.mutateItem);
  const pending = useInboxStore((state) => state.pendingIds.has(item.id));
  const setDetailCard = useBoardStore((state) => state.setDetailCard);
  const setWorkspaceMode = useUIStore((state) => state.setWorkspaceMode);
  const card = useBoardStore((state) =>
    state.cards.find((candidate) => candidate.id === item.cardId),
  );

  useEffect(() => {
    if (selected) {
      articleRef.current?.scrollIntoView({
        behavior: "auto",
        block: "nearest",
      });
    }
  }, [selected]);

  const runMutation = async (
    mutation: Parameters<typeof mutateItem>[1],
  ) => {
    setActionError(null);
    const result = await mutateItem(item.id, mutation);
    if (result) return;

    setActionError("Planwerk couldn't update this inbox item. Try again.");
    setDetailsOpen(true);
    if (detailsRef.current) {
      detailsRef.current.open = true;
      detailsRef.current.scrollIntoView({
        behavior: "auto",
        block: "nearest",
      });
    }
  };

  const runAction = async (action: InboxSuggestedAction) => {
    setActionError(null);
    const target = routeInboxClientAction(
      item.briefing.trigger,
      action.kind,
      Boolean(card),
    );

    switch (target.type) {
      case "mutation":
        await runMutation({ action: target.action });
        return;
      case "board":
        setWorkspaceMode("board");
        return;
      case "card":
        setDetailCard(item.cardId);
        return;
      case "unavailable":
        setActionError("The source session is no longer available on the board.");
        setDetailsOpen(true);
        if (detailsRef.current) {
          detailsRef.current.open = true;
          detailsRef.current.scrollIntoView({
            behavior: "auto",
            block: "nearest",
          });
        }
        return;
    }
  };

  const isWipLimit = item.briefing.trigger === "wip-violation";
  const Icon = isWipLimit
    ? AlertTriangle
    : sourceIcons[item.sourceKind] ?? CircleDot;
  const sourceLabel = isWipLimit
    ? "Limit reached"
    : sourceLabels[item.sourceKind] ?? "Update";
  const unread = item.readAt === null;
  const urgent = item.priorityBand <= 2;
  const project = isWipLimit
    ? "Board"
    : projectName ?? item.projectName ?? "Unassigned";
  const note = confidenceNote(item);
  const canResolve =
    item.category === "read"
    || item.sourceKind === "review-ready"
    || item.sourceKind === "ship-ready";
  const resolveAction: InboxSuggestedAction = {
    id: "resolve-briefing",
    label: "Done",
    kind: "resolve",
  };
  const generatedAlternative = !isWipLimit &&
    item.briefing.synthesisStatus === "generated"
    ? item.briefing.alternativeActions.find(
        (action) =>
          action.id !== item.briefing.defaultAction.id &&
          action.kind !== item.briefing.defaultAction.kind,
      )
    : undefined;
  const secondaryAction = item.briefing.defaultAction.kind === "resolve"
    ? generatedAlternative
    : item.category === "read" || (!generatedAlternative && canResolve)
      ? resolveAction
      : generatedAlternative;
  const artifacts = (card?.artifacts ?? [])
    .filter((candidate) => candidate.contentRef)
    .sort((a, b) => {
      const order: Partial<Record<ArtifactType, number>> = {
        review: 0,
        plan: 1,
      };
      return (order[a.type] ?? 2) - (order[b.type] ?? 2);
    });

  return (
    <>
      <article
        ref={articleRef}
        tabIndex={0}
        aria-current={selected ? "true" : undefined}
        onClick={() => selectItem(item.id)}
        onFocus={() => selectItem(item.id)}
        className={cn(
          "group/feed relative grid scroll-m-3 grid-cols-[1.75rem_minmax(0,1fr)] gap-3 border-b border-border/60 px-2 py-3.5 outline-none transition-colors duration-150 @min-[680px]/inbox:px-3",
          selected ? "bg-primary/[0.045]" : "hover:bg-background/60",
        )}
      >
      <span
        className={cn(
          "mt-0.5 flex h-7 w-7 items-center justify-center rounded-md border bg-background",
          urgent
            ? "border-pw-warning/40 bg-pw-warning/10 text-pw-warning-foreground"
            : "border-border/80 text-muted-foreground",
        )}
        title={sourceLabel}
      >
        <Icon className="h-3.5 w-3.5" />
        <span className="sr-only">{sourceLabel}</span>
      </span>

      <div className="min-w-0">
        <header className="flex min-w-0 items-start gap-2">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
              <span className="truncate font-medium text-foreground/70">{project}</span>
              <span aria-hidden>·</span>
              <time
                className="shrink-0"
                dateTime={new Date(item.updatedAt).toISOString()}
                title={formattedTime(item.updatedAt)}
              >
                {relativeTime(item.updatedAt)}
              </time>
              {item.briefing.synthesisStatus === "generated" && (
                <Sparkles
                  className="h-2.5 w-2.5 text-primary/70"
                  aria-label="Chief of Staff briefing"
                />
              )}
              {item.briefing.synthesisStatus === "pending" && (
                <>
                  <span aria-hidden>·</span>
                  <span>Drafting</span>
                </>
              )}
              {item.briefing.synthesisStatus === "failed" && (
                <>
                  <span aria-hidden>·</span>
                  <span title="Chief of Staff synthesis unavailable">
                    Source note
                  </span>
                </>
              )}
              {urgent && (
                <>
                  <span aria-hidden>·</span>
                  <span className="truncate font-medium text-pw-warning-foreground">
                    {sourceLabel}
                  </span>
                </>
              )}
            </div>
            <h3
              className={cn(
                "mt-1 break-words text-pretty text-[13px] leading-[1.125rem] text-foreground",
                unread ? "font-semibold" : "font-medium",
              )}
            >
              {unread && (
                <span
                  className="mr-1.5 inline-block h-1.5 w-1.5 rounded-full bg-primary align-middle"
                  aria-label="Unread"
                />
              )}
              {item.title}
            </h3>
          </div>
          {item.pinnedAt && (
            <Pin
              className="mt-0.5 h-3 w-3 shrink-0 fill-current text-primary"
              aria-label="Pinned"
            />
          )}
        </header>

        <div className="flex flex-wrap items-end gap-x-5">
          <div className="min-w-[min(28rem,100%)] flex-1">
            <p className="mt-1.5 max-w-[88ch] text-pretty text-[12px] leading-[1.2rem] text-foreground/75">
              {item.briefing.message}
            </p>

            {artifacts.length > 0 && (
              <div
                className="mt-2 flex flex-wrap items-center gap-1"
                onClick={(event) => event.stopPropagation()}
              >
                {artifacts.slice(0, 3).map((candidate) => {
                  const ArtifactIcon = artifactIcons[candidate.type];
                  return (
                    <button
                      key={candidate.id}
                      type="button"
                      onClick={() => setArtifact(candidate)}
                      title={candidate.title}
                      className="inline-flex h-6 items-center gap-1 rounded border border-border/70 bg-background px-1.5 text-[10px] font-medium text-muted-foreground transition-colors hover:border-border hover:text-foreground"
                    >
                      <ArtifactIcon className="h-3 w-3" />
                      {artifactLabels[candidate.type]}
                    </button>
                  );
                })}
                {artifacts.length > 3 && (
                  <span className="px-1 text-[10px] text-muted-foreground">
                    +{artifacts.length - 3}
                  </span>
                )}
              </div>
            )}
          </div>

          <div
            className="mt-2.5 flex shrink-0 flex-wrap items-center gap-1.5"
            onClick={(event) => event.stopPropagation()}
          >
            <Button
              size="xs"
              disabled={pending}
              onClick={() => void runAction(item.briefing.defaultAction)}
            >
              {pending && <Loader2 className="motion-safe:animate-spin" />}
              {actionLabel(item, item.briefing.defaultAction)}
            </Button>
            {item.workflowState === "open" && secondaryAction && (
              <Button
                variant="ghost"
                size="xs"
                disabled={pending}
                onClick={() => void runAction(secondaryAction)}
              >
                {secondaryAction.label}
              </Button>
            )}
            <details
              ref={detailsRef}
              className="group/details"
              onToggle={(event) => setDetailsOpen(event.currentTarget.open)}
              onClick={(event) => event.stopPropagation()}
            >
              <summary className="flex h-6 cursor-pointer list-none items-center gap-1 rounded px-1.5 text-[10px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground">
                Details
                <ChevronDown className="h-3 w-3 transition-transform duration-150 group-open/details:rotate-180" />
              </summary>
            </details>
            <span className="mx-0.5 h-4 w-px bg-border/80" aria-hidden />
            <Button
              variant="ghost"
              size="icon-xs"
              disabled={pending}
              title={unread ? "Mark read" : "Mark unread"}
              aria-label={unread ? "Mark read" : "Mark unread"}
              onClick={() =>
                void runMutation(
                  unread ? { action: "read" } : { action: "unread" },
                )}
            >
              {unread ? <MailOpen /> : <Mail />}
            </Button>
            {(item.workflowState === "open" || item.workflowState === "snoozed") && (
              <Button
                variant="ghost"
                size="icon-xs"
                disabled={pending}
                title={
                  item.workflowState === "snoozed"
                    ? "Unsnooze"
                    : "Snooze for one hour"
                }
                aria-label={
                  item.workflowState === "snoozed"
                    ? "Unsnooze"
                    : "Snooze for one hour"
                }
                onClick={() =>
                  void runMutation(
                    item.workflowState === "snoozed"
                      ? { action: "unsnooze" }
                      : {
                          action: "snooze",
                          snoozedUntil: Date.now() + 60 * 60 * 1000,
                        },
                  )}
              >
                <Clock3 />
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon-xs"
              disabled={pending}
              title={item.pinnedAt ? "Unpin" : "Pin"}
              aria-label={item.pinnedAt ? "Unpin" : "Pin"}
              className={cn(item.pinnedAt && "text-primary")}
              onClick={() =>
                void runMutation(
                  item.pinnedAt ? { action: "unpin" } : { action: "pin" },
                )}
            >
              {item.pinnedAt ? <PinOff /> : <Pin />}
            </Button>
          </div>
        </div>

        <div className={cn(detailsOpen ? "block" : "hidden")}>
          <div className="mt-3 max-w-[66ch] space-y-2 border-t border-border/60 pt-3 text-[11px] leading-4 text-muted-foreground">
            {actionError && (
              <p role="alert" className="flex gap-2 text-destructive">
                <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                <span>{actionError}</span>
              </p>
            )}
            {item.briefing.synthesisStatus === "pending" && (
              <p className="flex items-center gap-1.5 text-foreground/70">
                <Sparkles className="h-3 w-3 motion-safe:animate-pulse" />
                Refining this briefing…
              </p>
            )}
            {item.briefing.synthesisStatus === "failed" && (
              <p>Showing the source summary because a synthesized briefing is unavailable.</p>
            )}
            {item.briefing.outcome && (
              <p className="text-foreground/80">{item.briefing.outcome}</p>
            )}
            {item.briefing.caveats.length > 0 && (
              <p className="flex gap-2 text-pw-warning-foreground">
                <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                <span>{item.briefing.caveats.join(" ")}</span>
              </p>
            )}
            {note && <p className="text-pw-warning-foreground">{note}</p>}
          </div>

        </div>
      </div>
      </article>
      <ArtifactViewer
        artifact={artifact}
        open={artifact !== null}
        onOpenChange={(open) => {
          if (!open) setArtifact(null);
        }}
      />
    </>
  );
}
