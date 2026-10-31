import { isCardInAutomationScope, isCardInAnyAutomationScope } from "../automation-scope.ts";
import type { KanbanCard } from "../types.ts";

export interface CoordinatorHost {
  generation: number;
  cards: KanbanCard[];
  scopes: ReadonlySet<string>[];
}

type HostReader = (hostUrl: string) => CoordinatorHost | undefined;
const shared = globalThis as typeof globalThis & {
  __planwerkCoordinatorHostReader?: HostReader;
};

/** Reads the existing stream registry; this never owns a second card catalogue. */
export function registerCoordinatorHostReader(reader: HostReader): void {
  shared.__planwerkCoordinatorHostReader = reader;
}

export function getCoordinatorHost(hostUrl: string): CoordinatorHost | undefined {
  return shared.__planwerkCoordinatorHostReader?.(hostUrl);
}

export function scopedCoordinatorCards(
  host: CoordinatorHost,
  workspaceScope: readonly string[],
): KanbanCard[] {
  const selected = new Set(workspaceScope);
  return host.cards.filter((card) =>
    !card.isArchived && !card.ownershipConflict &&
    isCardInAutomationScope(card, selected) &&
    isCardInAnyAutomationScope(card, host.scopes)
  );
}

export function coordinatorDirectoryAllowed(
  host: CoordinatorHost,
  workspaceScope: readonly string[],
  workingDirectory: string,
): boolean {
  return scopedCoordinatorCards(host, workspaceScope)
    .some((card) => card.workingDirectory === workingDirectory);
}
