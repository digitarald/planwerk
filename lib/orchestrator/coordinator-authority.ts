import "server-only";

import path from "node:path";
import type { KanbanCard } from "../types.ts";
import { coordinatorModeAllows, type CoordinatorCapability } from "./coordinator-mode.ts";
import { getCoordinatorDefaultMode, getEffectiveCoordinatorMode } from "./coordinator-mode-store.ts";
import { coordinatorDirectoryAllowed, getCoordinatorHost, scopedCoordinatorCards } from "./coordinator-hosts.ts";
import { isWorkspaceEnabled } from "./config-file.ts";
import { getCoordinatorOperationAdmission } from "./operation-admission.ts";
import { assertOperationCurrent, withOperationContext } from "./operation-context.ts";
import { getPersistedCardPhase } from "./gate-engine.ts";
import { getAuthoritativeRiskSnapshot } from "./risk-store.ts";

export interface CoordinatorScope {
  hostUrl: string;
  workspaceScope: string[];
  isCurrent?: () => boolean;
}

export function currentCoordinatorCards(scope: CoordinatorScope): KanbanCard[] {
  const host = getCoordinatorHost(scope.hostUrl);
  if (!host) throw new Error("Connect an active board before querying or coordinating sessions.");
  return scopedCoordinatorCards(host, scope.workspaceScope);
}

function cardIdentity(hostUrl: string, card: KanbanCard): string {
  return JSON.stringify([
    card.id, card.phase, card.runtime, card.sourceRevision, card.planContentHash,
    card.pendingInput?.requestId, card.workingDirectory, card.ownershipConflict, card.outcomeEvidence,
    getPersistedCardPhase(card.id), getAuthoritativeRiskSnapshot(hostUrl, card.id)?.digest,
  ]);
}

export async function withCoordinatorAuthority<T>(
  scope: CoordinatorScope,
  target: { cardId: string } | { workingDirectory: string; resource: string },
  capability: CoordinatorCapability,
  signal: AbortSignal | undefined,
  operation: (cards: KanbanCard[]) => Promise<T>,
): Promise<T> {
  const host = getCoordinatorHost(scope.hostUrl);
  if (!host) throw new Error("The selected host is not connected.");
  const cards = currentCoordinatorCards(scope);
  const card = "cardId" in target ? cards.find((item) => item.id === target.cardId) : undefined;
  if ("cardId" in target && !card) throw new Error("Session is unavailable or outside the selected workspace scope.");
  if ("workingDirectory" in target &&
      (!path.isAbsolute(target.workingDirectory) ||
       !coordinatorDirectoryAllowed(host, scope.workspaceScope, target.workingDirectory) ||
       !isWorkspaceEnabled({ workingDirectory: target.workingDirectory }))) {
    throw new Error("A permitted absolute working directory is required.");
  }
  const key = card?.id ?? ("resource" in target ? target.resource : "");
  const identity = card && cardIdentity(scope.hostUrl, card);
  const isCurrent = (required: CoordinatorCapability) => {
    if (scope.isCurrent?.() === false) return false;
    const currentHost = getCoordinatorHost(scope.hostUrl);
    if (!currentHost || currentHost.generation !== host.generation) return false;
    if (card) {
      const current = scopedCoordinatorCards(currentHost, scope.workspaceScope).find((item) => item.id === card.id);
      return Boolean(current && cardIdentity(scope.hostUrl, current) === identity &&
        coordinatorModeAllows(getEffectiveCoordinatorMode(scope.hostUrl, card.id), required));
    }
    return "workingDirectory" in target &&
      coordinatorDirectoryAllowed(currentHost, scope.workspaceScope, target.workingDirectory) &&
      isWorkspaceEnabled({ workingDirectory: target.workingDirectory }) &&
      coordinatorModeAllows(getCoordinatorDefaultMode(), required);
  };
  if (!isCurrent(capability)) throw new Error(`Selected coordinator mode does not permit ${capability}, or its source changed.`);
  const lease = getCoordinatorOperationAdmission().acquire(scope.hostUrl, key);
  if (!lease) throw new Error("Another operation is active or uncertain for this session; inspect before retrying.");
  try {
    return await withOperationContext({
      hostUrl: scope.hostUrl, cardId: key, signal: signal ?? new AbortController().signal,
      lease, isCurrent,
    }, async () => {
      assertOperationCurrent(capability);
      return operation(cards);
    });
  } finally {
    lease.finish();
  }
}
