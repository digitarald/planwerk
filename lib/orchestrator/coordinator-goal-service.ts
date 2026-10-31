import "server-only";

import { CoordinatorGoalStore, coordinatorId } from "../db/coordinator-goals";
import { getDb } from "../db/schema";
import { UNASSIGNED_WORKSPACE } from "../automation-scope";
import type { CoordinatorGoal, GoalState } from "./coordinator-goal-types";
import { coordinatorGoalEvents } from "./coordinator-goal-events";
import { currentCoordinatorCards, type CoordinatorScope } from "./coordinator-authority";
import { coordinatorDirectoryAllowed, getCoordinatorHost } from "./coordinator-hosts";
import { isWorkspaceEnabled } from "./config-file";
import { projectCoordinatorGoalToInbox } from "../inbox/service";

export const getCoordinatorGoalStore = () => new CoordinatorGoalStore(getDb());

export function goalInScope(goal: CoordinatorGoal, scope: CoordinatorScope): boolean {
  return goal.hostUrl === scope.hostUrl &&
    (scope.workspaceScope.length === 0 || goal.workspaceScope.every((path) => scope.workspaceScope.includes(path)));
}

export function listCoordinatorGoals(scope: CoordinatorScope): CoordinatorGoal[] {
  return getCoordinatorGoalStore().list(scope.hostUrl, 50, scope.workspaceScope);
}

export function manageCoordinatorGoal(
  scope: CoordinatorScope,
  args: Record<string, unknown>,
  auditKey: string,
): CoordinatorGoal {
  const store = getCoordinatorGoalStore();
  const result = store.command(auditKey, { ...args, hostUrl: scope.hostUrl, workspaceScope: scope.workspaceScope },
    () => applyCoordinatorGoalCommand(scope, args, auditKey));
  try {
    coordinatorGoalEvents.publish(scope.hostUrl);
    projectCoordinatorGoalToInbox(result);
  } catch (error) {
    throw new Error("Goal saved, but progress notifications failed. Reload goals before retrying.", { cause: error });
  }
  return result;
}

function applyCoordinatorGoalCommand(
  scope: CoordinatorScope, args: Record<string, unknown>, auditKey: string,
): CoordinatorGoal {
  const store = getCoordinatorGoalStore();
  const action = String(args.action);
  const required = (key: string) => {
    const value = args[key];
    if (typeof value !== "string" || !value.trim() || value.length > 12_000) throw new Error(`${key} is required and must be at most 12000 characters.`);
    return value;
  };
  let result: CoordinatorGoal;
  if (action === "create") {
    const cards = currentCoordinatorCards(scope);
    const paths = scope.workspaceScope.length ? scope.workspaceScope
      : [...new Set(cards.map((card) => card.project?.path ?? UNASSIGNED_WORKSPACE))];
    result = store.create({
      id: coordinatorId(auditKey), hostUrl: scope.hostUrl, workspaceScope: paths,
      objective: required("objective"), acceptanceCriteria: required("acceptanceCriteria"),
    });
  } else {
    const goal = store.get(required("goalId"));
    if (!goal || !goalInScope(goal, scope)) throw new Error("Goal is unavailable in this host/workspace scope.");
    if (typeof args.revision !== "number" || args.revision !== goal.revision) throw new Error("Current goal revision is required; read_goal before editing.");
    const edges = Array.isArray(args.dependencies) ? args.dependencies.map((itemId) => ({
      itemId: String(itemId), kind: args.dependencyKind === "verified" ? "verified" as const : "result" as const,
    })) : [];
    if (action === "add_work") {
      const directory = required("workingDirectory");
      const host = getCoordinatorHost(scope.hostUrl);
      if (!host || !coordinatorDirectoryAllowed(host, goal.workspaceScope, directory) ||
          !coordinatorDirectoryAllowed(host, scope.workspaceScope, directory) ||
          !isWorkspaceEnabled({ workingDirectory: directory })) throw new Error("Work must target a connected, enabled, in-scope workspace.");
      const cardId = typeof args.cardId === "string" ? args.cardId : undefined;
      if (cardId && !currentCoordinatorCards({ ...scope, workspaceScope: goal.workspaceScope })
        .some((card) => card.id === cardId && card.workingDirectory === directory)) throw new Error("Assigned session is not in this goal's workspace.");
      result = store.addItem(goal.id, goal.revision, {
        id: coordinatorId(auditKey), instructions: required("instructions"),
        acceptanceCriteria: required("acceptanceCriteria"), workingDirectory: directory, cardId, dependencies: edges,
      });
    } else if (action === "dependencies") {
      result = store.setDependencies(goal.id, goal.revision, required("itemId"), edges);
    } else if (action === "update") {
      result = store.update(goal.id, goal.revision, {
        objective: required("objective"), acceptanceCriteria: required("acceptanceCriteria"),
      });
    } else {
      const states: Record<string, GoalState> = { activate: "active", resume: "active", pause: "paused", cancel: "cancelled" };
      const state = states[action];
      if (!state) throw new Error("Unsupported goal action.");
      if (state === "active" && !goal.items.length) throw new Error("Add at least one work item before activating this goal.");
      if (state === "active" && goal.items.some((item) => item.state === "uncertain" || item.state === "queued")) throw new Error("Uncertain or queued delivery requires inspection; create a new explicitly scoped follow-up instead of resending.");
      result = store.update(goal.id, goal.revision, {
        state, evidenceDigest: undefined,
        summary: state === "cancelled" ? "Future follow-ups cancelled. Already accepted worker commands are not stopped." : undefined,
      });
    }
  }
  return result;
}
