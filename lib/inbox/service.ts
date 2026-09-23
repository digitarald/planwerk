import type Database from "better-sqlite3";

import { getDb } from "../db/schema.ts";
import {
  applyInboxAction,
  getInboxItem,
  getInboxItemBySourceKey,
  listInboxItems,
  resolveInboxKind,
  resolveInboxSource,
  updateInboxPresentationIfCurrent,
  upsertInboxItem,
  type InboxMutation,
} from "../db/inbox-store.ts";
import type { AHPSessionSummary } from "../ahp/types.ts";
import type { HeartbeatAction } from "../orchestrator/heartbeat.ts";
import type { KanbanCard } from "../types.ts";
import { inboxEvents } from "./events.ts";
import {
  inboxItemMatchesHost,
  serializeInboxItem,
} from "./contract.ts";
import {
  projectArchivedSession,
  projectCardSnapshot,
  projectExistingCompletionRefresh,
  projectHeartbeatAction,
  projectRemovedSession,
} from "./projector.ts";
import {
  scopedInboxSourceKey,
  scopeInboxProjection,
} from "./projection-scope.ts";
import {
  applySynthesizedBriefing,
  briefingSynthesisVersion,
  canApplySynthesizedBriefing,
  synthesisRequestId,
  type InboxSynthesisEvidence,
} from "./briefing-synthesis-core.ts";
import { generateInboxBriefing } from "./briefing-generator.ts";
import type {
  InboxActionType,
  InboxItem,
  InboxItemAction,
  InboxProjectionOperation,
} from "./types.ts";

interface SynthesisQueueState {
  active: number;
  queued: Array<() => Promise<void>>;
  latestRequestBySource: Map<string, string>;
}

const globalSynthesisQueue = globalThis as typeof globalThis & {
  __planwerkInboxSynthesisQueue?: SynthesisQueueState;
};
const defaultSynthesisQueue: SynthesisQueueState = {
  active: 0,
  queued: [],
  latestRequestBySource: new Map(),
};
const synthesisQueue =
  globalSynthesisQueue.__planwerkInboxSynthesisQueue ??= defaultSynthesisQueue;
const MAX_CONCURRENT_SYNTHESIS = 2;
const MAX_SYNTHESIS_REFRESH_BATCH = 10;
const FAILED_RETRY_DELAY_MS = 5 * 60 * 1_000;

function boundedText(value: string | undefined, limit = 12_000): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit - 1)}…`;
}

function boundedValue(value: unknown, limit = 6_000): unknown {
  if (value === undefined) return undefined;
  const serialized = JSON.stringify(value);
  if (serialized.length <= limit) return value;
  return `${serialized.slice(0, limit - 1)}…`;
}

function synthesisEvidence(
  item: Extract<InboxProjectionOperation, { type: "upsert" }>["item"],
  card?: KanbanCard,
  event?: unknown,
): InboxSynthesisEvidence {
  return {
    taskTitle: card?.title ?? item.title,
    kind: item.kind,
    eventType: item.briefing.provenance.eventType,
    sourceRevision: item.sourceRevision,
    currentBriefing: {
      reason: item.briefing.reason,
      recommendation: item.briefing.recommendation,
      outcome: item.briefing.outcome,
      caveats: item.briefing.caveats,
    },
    session: card
      ? {
          phase: card.phase,
          runtime: card.runtime,
          gateStatus: card.gateStatus,
          attention: card.attention,
          risk: card.risk,
          activity: boundedText(card.activity, 2_000),
          finalResponse: boundedText(card.lastAgentMessage),
          changes: {
            files: card.filesChanged,
            additions: card.additions,
            deletions: card.deletions,
            verified: card.changesetVerified === true,
            paths: (card.fileChanges ?? []).slice(0, 40).map(({ path }) => path),
          },
          artifacts: (card.artifacts ?? []).slice(0, 20).map(
            ({ type, title }) => ({ type, title }),
          ),
          pendingInput: boundedValue(card.pendingInput),
          reviewFindings: boundedValue((card.reviewFindings ?? []).slice(0, 10)),
          recentActivity: boundedValue((card.recentActivity ?? []).slice(-10)),
        }
      : undefined,
    event: boundedValue(event),
  };
}

function runNextSynthesis(): void {
  while (
    synthesisQueue.active < MAX_CONCURRENT_SYNTHESIS &&
    synthesisQueue.queued.length > 0
  ) {
    const task = synthesisQueue.queued.shift();
    if (!task) return;
    synthesisQueue.active += 1;
    void task().finally(() => {
      synthesisQueue.active -= 1;
      runNextSynthesis();
    });
  }
}

function enqueueSynthesis(task: () => Promise<void>): void {
  synthesisQueue.queued.push(task);
  runNextSynthesis();
}

function prepareSynthesisOperations(
  hostUrl: string,
  operations: InboxProjectionOperation[],
  db: Database.Database,
  card?: KanbanCard,
  event?: unknown,
): {
  operations: InboxProjectionOperation[];
  evidenceByRequest: Map<string, InboxSynthesisEvidence>;
} {
  const evidenceByRequest = new Map<string, InboxSynthesisEvidence>();
  const prepared = operations.map((operation): InboxProjectionOperation => {
    if (operation.type !== "upsert") return operation;
    const evidence = synthesisEvidence(operation.item, card, event);
    const requestId = synthesisRequestId(evidence);
    const existing = getInboxItemBySourceKey(
      db,
      scopedInboxSourceKey(hostUrl, operation.item.sourceKey),
    );
    const existingSynthesis = existing?.briefing.synthesis;
    const failedRecently =
      existingSynthesis?.status === "failed" &&
      existingSynthesis.requestId === requestId &&
      existingSynthesis.generatedAt !== undefined &&
      Date.now() - Date.parse(existingSynthesis.generatedAt) <
        FAILED_RETRY_DELAY_MS;
    if (
      existing?.sourceRevision === operation.item.sourceRevision &&
      existingSynthesis?.requestId === requestId &&
      (
        existingSynthesis.status === "generated" ||
        (
          existingSynthesis.status === "pending" &&
          synthesisQueue.latestRequestBySource.get(existing.sourceKey) ===
            requestId
        ) ||
        failedRecently
      )
    ) {
      return {
        ...operation,
        item: {
          ...operation.item,
          title: existing.title,
          briefing: existing.briefing,
        },
      };
    }

    evidenceByRequest.set(requestId, evidence);
    return {
      ...operation,
      item: {
        ...operation.item,
        briefing: {
          ...operation.item.briefing,
          synthesis: {
            status: "pending",
            requestId,
            version: briefingSynthesisVersion(),
          },
        },
      },
    };
  });
  return { operations: prepared, evidenceByRequest };
}

function scheduleSynthesis(
  mutations: InboxMutation[],
  evidenceByRequest: Map<string, InboxSynthesisEvidence>,
  db: Database.Database,
): void {
  for (const mutation of mutations) {
    const requestId = mutation.item.briefing.synthesis?.requestId;
    if (
      !mutation.changed ||
      mutation.item.workflowState !== "open" ||
      mutation.item.briefing.synthesis?.status !== "pending" ||
      !requestId
    ) {
      continue;
    }
    const evidence = evidenceByRequest.get(requestId);
    if (!evidence) continue;

    const sourceKey = mutation.item.sourceKey;
    synthesisQueue.latestRequestBySource.set(sourceKey, requestId);
    enqueueSynthesis(async () => {
      try {
        if (
          synthesisQueue.latestRequestBySource.get(sourceKey) !== requestId ||
          !canApplySynthesizedBriefing(
            getInboxItemBySourceKey(db, sourceKey),
            evidence.sourceRevision,
            requestId,
          )
        ) {
          return;
        }
        const generated = await generateInboxBriefing(evidence);
        if (
          synthesisQueue.latestRequestBySource.get(sourceKey) !== requestId
        ) {
          return;
        }
        const generatedAt = new Date().toISOString();
        const generatedMutation = updateInboxPresentationIfCurrent(
          db,
          sourceKey,
          evidence.sourceRevision,
          requestId,
          (current) => {
            const draft = applySynthesizedBriefing(
              current,
              generated.briefing,
              generated.model,
              generatedAt,
              requestId,
            );
            return {
              title: draft.title,
              briefing: draft.briefing,
            };
          },
        );
        if (generatedMutation) publishMutation(generatedMutation);
      } catch (error) {
        console.warn(
          "[inbox:briefing] Synthesis failed:",
          error instanceof Error ? error.message : error,
        );
        if (
          synthesisQueue.latestRequestBySource.get(sourceKey) !== requestId
        ) {
          return;
        }
        const failedAt = new Date().toISOString();
        const failedMutation = updateInboxPresentationIfCurrent(
          db,
          sourceKey,
          evidence.sourceRevision,
          requestId,
          (current) => ({
            title: current.title,
            briefing: {
              ...current.briefing,
              synthesis: {
                status: "failed",
                requestId,
                version: briefingSynthesisVersion(),
                generatedAt: failedAt,
              },
            },
          }),
        );
        if (failedMutation) publishMutation(failedMutation);
      } finally {
        if (
          synthesisQueue.latestRequestBySource.get(sourceKey) === requestId
        ) {
          synthesisQueue.latestRequestBySource.delete(sourceKey);
        }
      }
    });
  }
}

export function refreshOpenInboxSynthesis(
  hostUrl?: string,
  db: Database.Database = getDb(),
): void {
  const items = listInboxItems(db, {
    workflowState: "open",
    hostUrl,
    limit: 200,
  }).items;
  let scheduled = 0;

  for (const item of items) {
    if (scheduled >= MAX_SYNTHESIS_REFRESH_BATCH) break;
    const synthesis = item.briefing.synthesis;
    const currentVersion = briefingSynthesisVersion();
    if (
      synthesis?.status === "generated" &&
      synthesis.version === currentVersion
    ) {
      continue;
    }
    if (
      synthesis?.status === "pending" &&
      synthesis.version === currentVersion &&
      synthesis.requestId &&
      synthesisQueue.latestRequestBySource.get(item.sourceKey) ===
        synthesis.requestId
    ) {
      continue;
    }
    if (
      synthesis?.status === "failed" &&
      synthesis.version === currentVersion &&
      synthesis.generatedAt &&
      Date.now() - Date.parse(synthesis.generatedAt) < FAILED_RETRY_DELAY_MS
    ) {
      continue;
    }

    const evidence: InboxSynthesisEvidence = {
      taskTitle: item.title,
      kind: item.kind,
      eventType: item.briefing.provenance.eventType,
      sourceRevision: item.sourceRevision,
      currentBriefing: {
        reason: item.briefing.reason,
        recommendation: item.briefing.recommendation,
        outcome: item.briefing.outcome,
        caveats: item.briefing.caveats,
      },
    };
    const requestId = synthesisRequestId(evidence);
    const mutation = upsertInboxItem(db, {
      sourceKey: item.sourceKey,
      sourceRevision: item.sourceRevision,
      kind: item.kind,
      cardId: item.cardId ?? undefined,
      relatedCardIds: item.relatedCardIds,
      title: item.title,
      briefing: {
        ...item.briefing,
        synthesis: {
          status: "pending",
          requestId,
          version: currentVersion,
        },
      },
    });
    publishMutation(mutation);
    scheduleSynthesis(
      [mutation],
      new Map([[requestId, evidence]]),
      db,
    );
    scheduled += 1;
  }
}

function publishMutation(mutation: InboxMutation): void {
  if (!mutation.changed) return;
  const hostUrl = mutation.item.briefing.provenance.hostUrl;
  if (!mutation.previous || mutation.previous.workflowState !== "open") {
    if (mutation.item.workflowState === "open") {
      inboxEvents.publish({
        type: "inboxAdded",
        item: serializeInboxItem(mutation.item),
        hostUrl,
      });
      return;
    }
  }
  inboxEvents.publish({
    type: "inboxChanged",
    item: serializeInboxItem(mutation.item),
    hostUrl,
  });
}

function publishProjectionMutation(mutation: InboxMutation): void {
  if (!mutation.changed) return;
  const hostUrl = mutation.item.briefing.provenance.hostUrl;
  if (
    mutation.previous?.workflowState !== "resolved" &&
    mutation.item.workflowState === "resolved"
  ) {
    inboxEvents.publish({
      type: "inboxRemoved",
      itemId: mutation.item.id,
      workflowState: "resolved",
      hostUrl,
    });
    return;
  }
  publishMutation(mutation);
}

export function applyInboxProjection(
  hostUrl: string,
  operations: InboxProjectionOperation[],
  db: Database.Database = getDb(),
): InboxMutation[] {
  const transaction = db.transaction((): InboxMutation[] => {
    const mutations: InboxMutation[] = [];
    for (const unscopedOperation of operations) {
      const operation = scopeInboxProjection(hostUrl, unscopedOperation);
      if (operation.type === "upsert") {
        mutations.push(upsertInboxItem(db, operation.item));
      } else if (operation.type === "resolve-source") {
        const mutation = resolveInboxSource(db, operation.sourceKey);
        if (mutation) mutations.push(mutation);
      } else {
        mutations.push(...resolveInboxKind(
          db,
          operation.kind,
          operation.cardId,
          operation.exceptSourceKey,
          hostUrl,
        ));
      }
    }
    return mutations;
  });
  const mutations = transaction.immediate();
  for (const mutation of mutations) {
    publishProjectionMutation(mutation);
  }
  return mutations;
}

export function projectCardToInbox(
  hostUrl: string,
  card: KanbanCard,
  previousCard?: KanbanCard,
  db: Database.Database = getDb(),
): void {
  const operations = projectCardSnapshot(card, previousCard, { hostUrl });
  if (
    !previousCard &&
    card.runtime === "idle" &&
    card.lastAgentMessage?.trim() &&
    listInboxItems(db, {
      workflowState: "open",
      kind: "completion",
      cardId: card.id,
      hostUrl,
      limit: 1,
    }).total > 0
  ) {
    operations.push(...projectExistingCompletionRefresh(card, { hostUrl }));
  }
  const prepared = prepareSynthesisOperations(
    hostUrl,
    operations,
    db,
    card,
  );
  const mutations = applyInboxProjection(hostUrl, prepared.operations, db);
  scheduleSynthesis(mutations, prepared.evidenceByRequest, db);
}

export function projectArchivedSessionToInbox(
  hostUrl: string,
  session: AHPSessionSummary,
): void {
  const db = getDb();
  const operations = projectArchivedSession(session, { hostUrl });
  const prepared = prepareSynthesisOperations(
    hostUrl,
    operations,
    db,
    undefined,
    session,
  );
  const mutations = applyInboxProjection(hostUrl, prepared.operations, db);
  scheduleSynthesis(mutations, prepared.evidenceByRequest, db);
}

export function projectRemovedSessionToInbox(
  hostUrl: string,
  cardId: string,
): void {
  applyInboxProjection(hostUrl, projectRemovedSession(cardId));
}

export function projectHeartbeatToInbox(
  hostUrl: string,
  action: HeartbeatAction,
  card?: KanbanCard,
): void {
  const db = getDb();
  const prepared = prepareSynthesisOperations(
    hostUrl,
    projectHeartbeatAction(action, card, { hostUrl }),
    db,
    card,
    action,
  );
  const mutations = applyInboxProjection(hostUrl, prepared.operations, db);
  scheduleSynthesis(mutations, prepared.evidenceByRequest, db);
}

export function performInboxAction(
  itemId: string,
  actionType: InboxActionType,
  note: string | null,
  snoozedUntil: string | null,
  expectedHostUrl?: string,
  db: Database.Database = getDb(),
):
  | { ok: true; item: InboxItem; action: InboxItemAction }
  | { ok: false; reason: "not-found" | "host-mismatch" } {
  const previous = getInboxItem(db, itemId);
  if (!previous) return { ok: false, reason: "not-found" };
  if (!inboxItemMatchesHost(previous, expectedHostUrl)) {
    return { ok: false, reason: "host-mismatch" };
  }
  const result = applyInboxAction(
    db,
    itemId,
    actionType,
    note,
    snoozedUntil,
  );
  if (!result) return { ok: false, reason: "not-found" };
  publishMutation({
    previous,
    item: result.item,
    changed:
      previous.workflowState !== result.item.workflowState ||
      previous.readState !== result.item.readState ||
      previous.pinnedAt !== result.item.pinnedAt ||
      previous.snoozedUntil !== result.item.snoozedUntil,
    inserted: false,
  });
  return { ok: true, item: result.item, action: result.action };
}
