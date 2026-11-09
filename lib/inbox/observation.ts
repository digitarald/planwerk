import type { KanbanCard } from "../types.ts";
import type { InboxBriefing, InboxItemDraft, InboxProvenance } from "./types.ts";

export type InboxObservation =
  | { type: "cached" }
  | { type: "catalog"; observedAt: string }
  | { type: "pending-input"; observedAt: string; requestId: string }
  | { type: "orchestrator"; observedAt: string };

type SessionIdentity = Pick<InboxProvenance, "sessionTitle" | "projectName" | "workspacePath">;
type InboxSource = Pick<InboxItemDraft, "kind" | "sourceKey" | "briefing">;

export function sessionIdentity(
  session: Pick<KanbanCard, "title" | "project"> | undefined,
): SessionIdentity {
  return {
    sessionTitle: session?.title,
    projectName: session?.project?.name,
    workspacePath: session?.project?.path,
  };
}

export function mergeInboxContext(
  previous: InboxBriefing | undefined,
  next: InboxBriefing,
): InboxBriefing {
  if (!previous) return next;
  return {
    ...next,
    provenance: {
      ...previous.provenance,
      ...Object.fromEntries(Object.entries(next.provenance)
        .filter(([, value]) => value !== undefined)),
    },
    freshness: {
      ...next.freshness,
      sourceObservedAt: next.freshness.sourceObservedAt ?? previous.freshness.sourceObservedAt,
    },
  };
}

function legacySourceObservedAt(item: InboxSource): string | undefined {
  return item.briefing.freshness.sourceObservedAt
    ?? (item.briefing.provenance.sourceType === "orchestrator"
      ? item.briefing.freshness.observedAt : undefined);
}

function sourceObservedAt(item: InboxSource, observation: InboxObservation): string | undefined {
  const previous = legacySourceObservedAt(item);
  if (observation.type === "cached") return previous;
  if (item.briefing.provenance.sourceType === "orchestrator") {
    return observation.type === "orchestrator" ? observation.observedAt : previous;
  }
  if (observation.type === "orchestrator") return previous;
  if (item.kind === "pending-input") {
    return observation.type === "pending-input"
      && item.sourceKey.endsWith(`:pending-input:${observation.requestId}`)
      ? observation.observedAt : previous;
  }
  return observation.observedAt;
}

export function observeInboxBriefing(
  item: InboxSource,
  identity: SessionIdentity,
  observation: InboxObservation,
): InboxBriefing {
  return mergeInboxContext(item.briefing, {
    ...item.briefing,
    provenance: { ...item.briefing.provenance, ...identity },
    freshness: {
      ...item.briefing.freshness,
      sourceObservedAt: sourceObservedAt(item, observation),
    },
  });
}
