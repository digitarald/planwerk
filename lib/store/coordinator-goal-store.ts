"use client";

import { create } from "zustand";
import type { CoordinatorGoal } from "../orchestrator/coordinator-goal-types";

type GoalView = CoordinatorGoal & { waitingReason?: string };
let generation = 0;
let controlGeneration = 0;
interface GoalState {
  goals: GoalView[];
  error?: string;
  loading: boolean;
  pending?: string;
  scopeKey?: string;
  refresh(hostUrl: string, workspaceScope: string[]): Promise<void>;
  control(goal: CoordinatorGoal, action: "pause" | "resume" | "cancel", workspaceScope: string[]): Promise<void>;
}

export const useCoordinatorGoalStore = create<GoalState>((set, get) => ({
  goals: [], loading: false,
  async refresh(hostUrl, workspaceScope) {
    const request = ++generation;
    const scopeKey = JSON.stringify([hostUrl, workspaceScope]);
    set({ scopeKey, goals: get().scopeKey === scopeKey ? get().goals : [], loading: true, error: undefined });
    try {
      const response = await fetch(`/api/orchestrator/goals?${new URLSearchParams({
        hostUrl, workspaceScope: JSON.stringify(workspaceScope),
      })}`);
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Could not load coordinator goals.");
      if (request === generation) set({ goals: payload.goals, loading: false });
    } catch (error) {
      if (request === generation) set({ error: error instanceof Error ? error.message : String(error), loading: false });
    }
  },
  async control(goal, action, workspaceScope) {
    const request = ++controlGeneration;
    const scopeKey = get().scopeKey;
    set({ pending: goal.id, error: undefined });
    try {
      const response = await fetch("/api/orchestrator/goals", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hostUrl: goal.hostUrl, workspaceScope,
          goalId: goal.id, revision: goal.revision, action, commandId: crypto.randomUUID() }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Could not update this goal. Reload and retry.");
      if (request === controlGeneration && get().scopeKey === scopeKey) await get().refresh(goal.hostUrl, workspaceScope);
    } catch (error) {
      if (request === controlGeneration && get().scopeKey === scopeKey) set({ error: error instanceof Error ? error.message : String(error) });
    } finally { if (request === controlGeneration) set({ pending: undefined }); }
  },
}));
