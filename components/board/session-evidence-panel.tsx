"use client";

import { Loader2, RotateCcw } from "lucide-react";
import { useId, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import type { KanbanCard } from "@/lib/types";

interface SessionEvidencePanelProps {
  card: KanbanCard;
  connected: boolean;
  refreshState: "idle" | "refreshing" | "ready" | "error";
  refreshError?: string;
  onRefresh(): void;
  ownershipRecovery?: ReactNode;
}

export function SessionEvidencePanel({
  card, connected, refreshState, refreshError, onRefresh, ownershipRecovery,
}: SessionEvidencePanelProps) {
  const warningId = useId();
  const capture = card.evidence?.capture;
  const time = capture && Number.isFinite(Date.parse(capture.capturedAt)) ? new Date(capture.capturedAt) : undefined;
  const label = card.evidence?.state === "current" ? "Captured evidence"
    : card.evidence?.state === "stale" ? "Evidence out of date" : "Evidence unavailable";
  const wait = card.automationWait;
  const ownershipBlocked = card.ownershipConflict || wait?.reason === "ownership";
  return (
    <section aria-label="Evidence and automation" className="min-w-0 border-t border-border/60 pt-3">
      <details open={card.ownershipConflict || Boolean(wait) || undefined}>
        <summary className="min-h-9 cursor-pointer content-center rounded-sm text-sm font-medium text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
          <span aria-live="polite">{wait?.summary ?? label}</span>
        </summary>
        <div className="mt-2 max-w-[72ch] space-y-2 text-sm leading-6 text-muted-foreground">
          {wait && <p className="max-w-prose">{wait.nextStep}</p>}
          {wait && !["ownership", "evidence", "gate"].includes(wait.reason) && card.gateBlocker && card.gateBlocker !== wait.summary && (
            <p className="max-w-prose">Required gate: {card.gateBlocker}.</p>
          )}
          {wait?.retryAt && <p>Next retry: <time dateTime={new Date(wait.retryAt).toISOString()}>{new Date(wait.retryAt).toLocaleTimeString()}</time>.</p>}
          {!ownershipBlocked && <>
            <p>
              {label}. {time
                ? <>Collected <time dateTime={time.toISOString()}>{time.toLocaleString()}</time> {capture?.source === "explicit" ? "by explicit refresh" : "during live observation"}.</>
                : "Collection time is not available."}
            </p>
            <p className="max-w-prose">
              {capture?.coverage === "bytes" ? "Includes captured file bytes and available plan/outcome."
                : capture?.coverage === "manifest" ? "Includes file metadata and available plan/outcome, not full file-byte capture."
                  : capture?.coverage === "transcript" ? "Includes available plan/outcome, not verified file changes." : "No recorded collection scope."}
              {" "}Collected evidence is not an approved gate or a guarantee of unchanged files.
            </p>
            <p>Full refresh limit: 256 files, 32 MiB, 30 seconds. Unsupported or changing evidence stays unverified.</p>
          </>}
          {ownershipRecovery}
          {!ownershipBlocked && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pt-2">
              <Button
                variant="ghost" size="sm"
                disabled={!connected || refreshState === "refreshing"}
                aria-busy={refreshState === "refreshing"}
                aria-describedby={warningId}
                onClick={onRefresh}
                title="Read plan, files, and outcome. This may restore the session and change its VS Code activity timestamp."
              >
                {refreshState === "refreshing"
                  ? <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
                  : <RotateCcw className="h-3.5 w-3.5" />}
                {refreshState === "refreshing" ? "Refreshing" : "Refresh evidence"}
              </Button>
              <p id={warningId} className="text-xs leading-5 text-muted-foreground">May restore the session and change its activity time.</p>
            </div>
          )}
        </div>
      </details>
      {refreshState === "ready" && <p role="status" className="mt-2 text-xs text-muted-foreground">Collection finished. Current facts are shown above; gates are unchanged.</p>}
      {refreshState === "error" && <p role="alert" className="mt-2 text-xs text-destructive">{refreshError}</p>}
    </section>
  );
}
