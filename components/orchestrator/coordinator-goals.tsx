"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { useBoardStore } from "@/lib/store/board-store";
import { useConnectionStore } from "@/lib/store/connection-store";
import { useCoordinatorPolicyStore } from "@/lib/store/coordinator-policy-store";
import { useCoordinatorGoalStore } from "@/lib/store/coordinator-goal-store";
import { useOrchestratorStore } from "@/lib/store/orchestrator-store";
import type { GoalState, WorkState } from "@/lib/orchestrator/coordinator-goal-types";

const goalLabels: Record<GoalState, string> = {
  draft: "Draft", active: "Active", paused: "Paused", "needs-human": "Needs decision",
  completed: "Completed", cancelled: "Cancelled",
};
const workLabels: Record<WorkState, string> = {
  ready: "Ready", dispatched: "Dispatched", queued: "Queued", "awaiting-result": "Awaiting result",
  blocked: "Blocked", completed: "Completed", failed: "Failed", uncertain: "Delivery uncertain",
};

export function CoordinatorGoals() {
  const hostUrl = useConnectionStore((state) => state.hostUrl);
  const status = useConnectionStore((state) => state.status);
  const filters = useBoardStore((state) => state.workspaceFilters);
  const setDetailCard = useBoardStore((state) => state.setDetailCard);
  const mode = useCoordinatorPolicyStore((state) => state.defaultMode);
  const setDraft = useOrchestratorStore((state) => state.setDraft);
  const { goals, loading, error, pending, refresh, control } = useCoordinatorGoalStore();
  const [confirmCancel, setConfirmCancel] = useState<string>();
  const scope = JSON.stringify([...filters].sort());
  useEffect(() => {
    if (hostUrl) void refresh(hostUrl, JSON.parse(scope));
  }, [hostUrl, scope, status, refresh]);

  return (
    <section aria-label="Coordinator goals" className="shrink-0 border-b px-4 pb-3">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold">Goals</h2>
        <span className="text-xs text-muted-foreground capitalize">{mode} · {filters.size || "All"} workspaces</span>
      </div>
      {status !== "connected" && <p className="mt-2 text-xs text-muted-foreground">Disconnected. Future work is paused.</p>}
      {error && <div role="alert" className="mt-2 text-xs text-destructive break-words">
        {error} <button className="underline" onClick={() => hostUrl && void refresh(hostUrl, JSON.parse(scope))}>Reload goals</button>
      </div>}
      {!goals.length && !error && <p className="mt-2 text-xs text-muted-foreground">{loading ? "Loading goals..." : "Ask the coordinator to draft a goal with acceptance criteria."}</p>}
      <div className="max-h-64 space-y-3 overflow-y-auto overscroll-contain">
        {goals.map((goal) => (
          <details key={goal.id} className="mt-2 text-xs">
            <summary className="cursor-pointer rounded-sm py-1 focus-visible:outline-2 focus-visible:outline-ring">
              <span className="font-medium break-words">{goal.objective}</span>
              <span className="ml-2 text-muted-foreground">{goalLabels[goal.state]} · {goal.items.filter((item) => item.state === "completed").length}/{goal.items.length}</span>
            </summary>
            <div className="space-y-2 pt-2 break-words">
              <p><span className="font-medium">Done when: </span>{goal.acceptanceCriteria}</p>
              <p className="text-muted-foreground break-all">Saved scope: {goal.workspaceScope.join(", ")}</p>
              {(goal.waitingReason || goal.summary) && <p className="text-muted-foreground">{goal.waitingReason ?? goal.summary}</p>}
              <ul className="space-y-2">
                {goal.items.map((item) => (
                  <li key={item.id}>
                    <p className="font-medium">{item.instructions}</p>
                    <p className="text-muted-foreground">{workLabels[item.state]}{item.evidence ? item.evidence.verified ? " · Verified result" : " · Awaiting verification" : ""}</p>
                    {item.cardId && <button className="underline underline-offset-2" onClick={() => setDetailCard(item.cardId!)}>Open session</button>}
                    {item.outcome && <p className="mt-1 whitespace-pre-wrap">{item.outcome}</p>}
                    {item.delivery && <p className="text-muted-foreground break-all">{item.delivery.queued ? "Queued message" : item.delivery.turnId ? "Dispatched turn" : "Reserved delivery"}: {item.delivery.chatUri ?? item.delivery.resource} {item.delivery.turnId ?? item.delivery.pendingMessageId ?? item.delivery.messageId}</p>}
                  </li>
                ))}
              </ul>
              {!["completed", "cancelled"].includes(goal.state) && <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="outline" disabled={Boolean(pending) || (goal.state !== "active" && goal.items.some((item) => item.state === "uncertain" || item.state === "queued"))} onClick={() => void control(goal, goal.state === "active" ? "pause" : "resume", JSON.parse(scope))}>{goal.state === "active" ? "Pause follow-ups" : goal.state === "draft" ? "Activate goal" : "Resume follow-ups"}</Button>
                <Button size="sm" variant="ghost" onClick={() => {
                  setDraft(`For goal "${goal.objective}" (ID ${goal.id}), `);
                  document.getElementById("coordinator-message")?.focus();
                }}>Steer in chat</Button>
                <Button size="sm" variant="ghost" disabled={pending === goal.id} onClick={() => setConfirmCancel(goal.id)}>Cancel goal</Button>
                {confirmCancel === goal.id && <div className="w-full space-y-2">
                  <p>Stop future follow-ups? Accepted worker commands keep running.</p>
                  <Button size="sm" variant="destructive" onClick={() => { setConfirmCancel(undefined); void control(goal, "cancel", JSON.parse(scope)); }}>Stop follow-ups</Button>
                  <Button size="sm" variant="ghost" onClick={() => setConfirmCancel(undefined)}>Keep goal</Button>
                </div>}
              </div>}
            </div>
          </details>
        ))}
      </div>
    </section>
  );
}
