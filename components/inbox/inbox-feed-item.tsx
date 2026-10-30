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
import { inboxSourceFreshness } from "@/lib/inbox/freshness";
import { useConnectionStore } from "@/lib/store/connection-store";
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

function relativeTime(timestamp: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1000));
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
  if (action.kind === "open-session") return "Open session";

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
      return action.label;
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
  now,
}: {
  item: InboxItem;
  projectName?: string;
  selected: boolean;
  now: number;
}) {
  const articleRef = useRef<HTMLElement>(null);
  const sourceFactsRef = useRef<HTMLDivElement>(null);
  const [artifact, setArtifact] = useState<Artifact | null>(null);
  const [sourceFactsOpen, setSourceFactsOpen] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const selectItem = useInboxStore((state) => state.selectItem);
  const mutateItem = useInboxStore((state) => state.mutateItem);
  const pending = useInboxStore((state) => state.pendingIds.has(item.id));
  const setDetailCard = useBoardStore((state) => state.setDetailCard);
  const setWorkspaceMode = useUIStore((state) => state.setWorkspaceMode);
  const card = useBoardStore((state) =>
    state.cards.find((candidate) => candidate.id === item.cardId),
  );
  const connected = useConnectionStore((state) => state.status === "connected");

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
    setSourceFactsOpen(true);
    if (sourceFactsRef.current) {
      sourceFactsRef.current.scrollIntoView({
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
        setSourceFactsOpen(true);
        if (sourceFactsRef.current) {
          sourceFactsRef.current.scrollIntoView({
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
    : projectName ?? item.projectName;
  const sessionTitle = item.sessionTitle ?? card?.title ?? "Session unavailable";
  const freshness = inboxSourceFreshness(item.briefing.freshness.sourceObservedAt, connected, now);
  const freshnessLabel = !card && !isWipLimit
    ? "Session unavailable"
    : item.briefing.trigger === "pending-input-unavailable"
      ? "Question unavailable"
      : freshness === "disconnected"
        ? "Disconnected"
        : freshness === "unverified"
          ? "Source unverified"
          : freshness === "stale" ? "Source may be out of date" : null;
  const actionUnavailable = (action: InboxSuggestedAction) =>
    routeInboxClientAction(item.briefing.trigger, action.kind, Boolean(card)).type === "unavailable";
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
  const evidenceSummary = item.briefing.evidenceSummary?.trim();
  const recommendationReason = item.briefing.recommendationReason.trim();
  const sourceEvidence = evidenceSummary || recommendationReason;
  const hasSourceFacts = Boolean(
    sourceEvidence
      || item.briefing.outcome
      || item.briefing.caveats.length > 0
      || item.briefing.freshness.sourceRevision
      || item.briefing.provenance !== "Planwerk"
      || item.briefing.synthesisStatus !== "generated"
      || note,
  );
  const sourceFactsId = `inbox-source-facts-${item.id}`;

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
            <div className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
              <span
                className="min-w-0 truncate font-medium text-foreground"
                title={isWipLimit ? project : [project, sessionTitle].filter(Boolean).join(" / ")}
              >
                {isWipLimit ? project : sessionTitle}
              </span>
              {!isWipLimit && project && (
                <span className="max-w-[35%] truncate" title={project}>{project}</span>
              )}
              <span aria-hidden>·</span>
              <time
                className="shrink-0"
                dateTime={new Date(item.createdAt).toISOString()}
                title={`Handoff received ${formattedTime(item.createdAt)}`}
              >
                {relativeTime(item.createdAt, now)}
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
            {!isWipLimit && freshnessLabel && (
              <p
                className="mt-1 text-[11px] text-pw-warning-foreground"
                title={item.briefing.freshness.sourceObservedAt
                  ? `Source last checked ${formattedTime(item.briefing.freshness.sourceObservedAt)}`
                  : "No authoritative source observation is available."}
              >
                {freshnessLabel}
              </p>
            )}
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
              disabled={pending || actionUnavailable(item.briefing.defaultAction)}
              title={actionUnavailable(item.briefing.defaultAction) ? "The source session is not available on the board." : undefined}
              onClick={() => void runAction(item.briefing.defaultAction)}
            >
              {pending && <Loader2 className="motion-safe:animate-spin" />}
              {actionLabel(item, item.briefing.defaultAction)}
            </Button>
            {item.workflowState === "open" && secondaryAction && (
              <Button
                variant="ghost"
                size="xs"
                disabled={pending || actionUnavailable(secondaryAction)}
                onClick={() => void runAction(secondaryAction)}
              >
                {secondaryAction.label}
              </Button>
            )}
            {(hasSourceFacts || actionError) && (
              <Button
                variant="ghost"
                size="xs"
                aria-expanded={sourceFactsOpen}
                aria-controls={sourceFactsId}
                onClick={() => setSourceFactsOpen((open) => !open)}
              >
                Source facts
                <ChevronDown
                  className={cn(
                    "transition-transform duration-150",
                    sourceFactsOpen && "rotate-180",
                  )}
                />
              </Button>
            )}
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

        <div
          ref={sourceFactsRef}
          id={sourceFactsId}
          className={cn(sourceFactsOpen ? "block" : "hidden")}
        >
          <div className="mt-3 max-w-[72ch] space-y-3 border-t border-border/60 pt-3 text-[11px] leading-4 text-muted-foreground">
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
            {sourceEvidence && (
              <div>
                <p className="font-medium text-foreground/80">Evidence</p>
                <p className="mt-0.5 text-foreground/70">{sourceEvidence}</p>
              </div>
            )}
            {item.briefing.outcome && (
              <div>
                <p className="font-medium text-foreground/80">Outcome</p>
                <p className="mt-0.5 text-foreground/70">{item.briefing.outcome}</p>
              </div>
            )}
            {item.briefing.caveats.length > 0 && (
              <p className="flex gap-2 text-pw-warning-foreground">
                <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                <span>{item.briefing.caveats.join(" ")}</span>
              </p>
            )}
            {note && <p className="text-pw-warning-foreground">{note}</p>}
            <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-1 border-t border-border/50 pt-2">
              <dt>Trigger</dt>
              <dd className="text-foreground/70">{sourceLabel}</dd>
              <dt>Observed</dt>
              <dd className="text-foreground/70">
                <time dateTime={new Date(item.briefing.freshness.generatedAt).toISOString()}>
                  {formattedTime(item.briefing.freshness.generatedAt)}
                </time>
              </dd>
              <dt>Confidence</dt>
              <dd className="capitalize text-foreground/70">
                {item.briefing.confidence}
              </dd>
              {item.briefing.freshness.sourceRevision && (
                <>
                  <dt>Revision</dt>
                  <dd className="break-all font-mono text-[10px] text-foreground/70">
                    {item.briefing.freshness.sourceRevision}
                  </dd>
                </>
              )}
              {item.briefing.provenance !== "Planwerk" && (
                <>
                  <dt>Source</dt>
                  <dd className="break-all text-foreground/70">
                    {item.briefing.provenance}
                  </dd>
                </>
              )}
            </dl>
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
