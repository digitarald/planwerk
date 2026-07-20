export const UNASSIGNED_WORKSPACE = "__unassigned__";

export interface WorkspaceScopedCard {
  project?: { path: string };
}

/**
 * A tab with no workspace filters intentionally exposes the entire board.
 * Multiple tabs combine their scopes, so any visible card remains eligible.
 */
export function isCardInAutomationScope(
  card: WorkspaceScopedCard,
  workspaceFilters: ReadonlySet<string>
): boolean {
  if (workspaceFilters.size === 0) return true;
  if (!card.project) return workspaceFilters.has(UNASSIGNED_WORKSPACE);
  return workspaceFilters.has(card.project.path);
}

export function isCardInAnyAutomationScope(
  card: WorkspaceScopedCard,
  scopes: Iterable<ReadonlySet<string> | null>
): boolean {
  for (const scope of scopes) {
    if (scope && isCardInAutomationScope(card, scope)) return true;
  }
  return false;
}

/**
 * An omitted scope supports older clients by preserving the historical
 * unfiltered behavior. A malformed supplied scope is rejected so it cannot
 * accidentally authorize work for every card.
 */
export function parseWorkspaceScope(value: string | null): Set<string> | null {
  if (value === null) return new Set();

  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === "string")) {
      return null;
    }
    return new Set(parsed);
  } catch {
    return null;
  }
}
