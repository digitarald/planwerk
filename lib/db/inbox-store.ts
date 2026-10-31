import { randomUUID } from "node:crypto";

import type Database from "better-sqlite3";

import { priorityForInboxKind } from "../inbox/priority.ts";
import {
  INBOX_ACTION_TYPES,
  type InboxActionType,
  type InboxBriefing,
  type InboxItem,
  type InboxItemAction,
  type InboxItemDraft,
  type InboxItemKind,
  type InboxListQuery,
  type InboxListResult,
  type InboxCounts,
  type InboxReadState,
  type InboxWorkflowState,
} from "../inbox/types.ts";

interface InboxItemRow {
  id: string;
  source_key: string;
  source_revision: string;
  kind: InboxItemKind;
  priority_band: InboxItem["priorityBand"];
  priority_rank: number;
  workflow_state: InboxWorkflowState;
  read_state: InboxReadState;
  card_id: string | null;
  related_card_ids_json: string;
  title: string;
  briefing_json: string;
  created_at: string;
  updated_at: string;
  read_at: string | null;
  resolved_at: string | null;
  pinned_at: string | null;
  snoozed_until: string | null;
}

interface InboxActionRow {
  id: number;
  inbox_item_id: string;
  action_type: InboxActionType;
  actor: "local-human";
  note: string | null;
  previous_workflow_state: InboxWorkflowState;
  next_workflow_state: InboxWorkflowState;
  previous_read_state: InboxReadState;
  next_read_state: InboxReadState;
  snoozed_until: string | null;
  created_at: string;
}

export interface InboxMutation {
  previous: InboxItem | null;
  item: InboxItem;
  changed: boolean;
  inserted: boolean;
}

export interface InboxPresentationUpdate {
  title: string;
  briefing: InboxBriefing;
}

function parseJson<T>(raw: string, field: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    throw new Error(
      `Invalid ${field} stored for inbox item: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function mapItem(row: InboxItemRow): InboxItem {
  return {
    id: row.id,
    sourceKey: row.source_key,
    sourceRevision: row.source_revision,
    kind: row.kind,
    priorityBand: row.priority_band,
    priorityRank: row.priority_rank,
    workflowState: row.workflow_state,
    readState: row.read_state,
    cardId: row.card_id,
    relatedCardIds: parseJson<string[]>(
      row.related_card_ids_json,
      "related card ids",
    ),
    title: row.title,
    briefing: parseJson<InboxBriefing>(row.briefing_json, "briefing"),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    readAt: row.read_at,
    resolvedAt: row.resolved_at,
    pinnedAt: row.pinned_at,
    snoozedUntil: row.snoozed_until,
  };
}

function mapAction(row: InboxActionRow): InboxItemAction {
  return {
    id: row.id,
    inboxItemId: row.inbox_item_id,
    actionType: row.action_type,
    actor: row.actor,
    note: row.note,
    previousWorkflowState: row.previous_workflow_state,
    nextWorkflowState: row.next_workflow_state,
    previousReadState: row.previous_read_state,
    nextReadState: row.next_read_state,
    snoozedUntil: row.snoozed_until,
    createdAt: row.created_at,
  };
}

function getItemRowBySourceKey(
  db: Database.Database,
  sourceKey: string,
): InboxItemRow | undefined {
  return db.prepare(
    "SELECT * FROM inbox_items WHERE source_key = ?",
  ).get(sourceKey) as InboxItemRow | undefined;
}

export function getInboxItem(
  db: Database.Database,
  itemId: string,
): InboxItem | null {
  const row = db.prepare(
    "SELECT * FROM inbox_items WHERE id = ?",
  ).get(itemId) as InboxItemRow | undefined;
  return row ? mapItem(row) : null;
}

export function getInboxItemBySourceKey(
  db: Database.Database,
  sourceKey: string,
): InboxItem | null {
  const row = getItemRowBySourceKey(db, sourceKey);
  return row ? mapItem(row) : null;
}

export function upsertInboxItem(
  db: Database.Database,
  draft: InboxItemDraft,
  now = new Date().toISOString(),
): InboxMutation {
  const transaction = db.transaction((): InboxMutation => {
    const existingRow = getItemRowBySourceKey(db, draft.sourceKey);
    const existingBriefing = existingRow ? mapItem(existingRow).briefing : undefined;
    const recoverPendingInput = existingRow?.workflow_state === "resolved"
      && draft.kind === "pending-input"
      && draft.recoverPendingInput === true
      && !hasInboxHumanResolution(db, existingRow.id);
    const priority = priorityForInboxKind(draft.kind);
    let nextTitle = draft.title;
    let nextBriefing = existingBriefing ? {
      ...draft.briefing,
      provenance: {
        ...existingBriefing.provenance,
        ...Object.fromEntries(Object.entries(draft.briefing.provenance)
          .filter(([, value]) => value !== undefined)),
      },
      freshness: {
        ...draft.briefing.freshness,
        sourceObservedAt: draft.briefing.freshness.sourceObservedAt
          ?? existingBriefing.freshness.sourceObservedAt,
      },
    } : draft.briefing;
    if (existingRow?.source_revision === draft.sourceRevision) {
      const existing = mapItem(existingRow);
      const existingSynthesis = existing.briefing.synthesis;
      if (
        existingSynthesis?.requestId &&
        existingSynthesis.requestId === draft.briefing.synthesis?.requestId &&
        existingSynthesis.status !== "pending"
      ) {
        nextTitle = existingSynthesis.status === "generated"
          ? existing.title
          : draft.title;
        nextBriefing = {
          ...nextBriefing,
          ...(existingSynthesis.status === "generated"
            ? {
                message: existing.briefing.message,
                recommendation: existing.briefing.recommendation,
                recommendedAction: existing.briefing.recommendedAction,
                alternativeActions: existing.briefing.alternativeActions,
              }
            : {}),
          synthesis: existingSynthesis,
        };
      }
    }
    const briefingJson = JSON.stringify(nextBriefing);
    const relatedCardIdsJson = JSON.stringify(draft.relatedCardIds ?? []);

    if (
      existingRow?.source_revision === draft.sourceRevision &&
      !recoverPendingInput &&
      existingRow.kind === draft.kind &&
      existingRow.priority_band === priority.band &&
      existingRow.priority_rank === priority.rank &&
      existingRow.card_id === (draft.cardId ?? null) &&
      existingRow.related_card_ids_json === relatedCardIdsJson &&
      existingRow.title === nextTitle &&
      existingRow.briefing_json === briefingJson
    ) {
      const item = mapItem(existingRow);
      return {
        previous: item,
        item,
        changed: false,
        inserted: false,
      };
    }

    if (!existingRow) {
      const id = randomUUID();
      db.prepare(`
        INSERT INTO inbox_items (
          id, source_key, source_revision, kind, priority_band,
          priority_rank, workflow_state, read_state, card_id,
          related_card_ids_json, title, briefing_json, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, 'open', 'unread', ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        draft.sourceKey,
        draft.sourceRevision,
        draft.kind,
        priority.band,
        priority.rank,
        draft.cardId ?? null,
        relatedCardIdsJson,
        nextTitle,
        briefingJson,
        now,
        now,
      );
      const inserted = getInboxItem(db, id);
      if (!inserted) throw new Error("Inserted inbox item could not be read.");
      return {
        previous: null,
        item: inserted,
        changed: true,
        inserted: true,
      };
    }

    const previous = mapItem(existingRow);
    if (existingRow.source_revision === draft.sourceRevision) {
      db.prepare(`
        UPDATE inbox_items
        SET kind = ?,
            priority_band = ?,
            priority_rank = ?,
            card_id = ?,
            related_card_ids_json = ?,
            title = ?,
            briefing_json = ?,
            workflow_state = CASE WHEN ? THEN 'open' ELSE workflow_state END,
            resolved_at = CASE WHEN ? THEN NULL ELSE resolved_at END
        WHERE id = ?
      `).run(
        draft.kind,
        priority.band,
        priority.rank,
        draft.cardId ?? null,
        relatedCardIdsJson,
        nextTitle,
        briefingJson,
        Number(recoverPendingInput),
        Number(recoverPendingInput),
        existingRow.id,
      );
      const item = getInboxItem(db, existingRow.id);
      if (!item) throw new Error("Refreshed inbox item could not be read.");
      return { previous, item, changed: true, inserted: false };
    }

    db.prepare(`
      UPDATE inbox_items
      SET source_revision = ?,
          kind = ?,
          priority_band = ?,
          priority_rank = ?,
          workflow_state = 'open',
          read_state = 'unread',
          card_id = ?,
          related_card_ids_json = ?,
          title = ?,
          briefing_json = ?,
          updated_at = ?,
          read_at = NULL,
          resolved_at = NULL,
          snoozed_until = NULL
      WHERE id = ?
    `).run(
      draft.sourceRevision,
      draft.kind,
      priority.band,
      priority.rank,
      draft.cardId ?? null,
      relatedCardIdsJson,
      nextTitle,
      briefingJson,
      now,
      existingRow.id,
    );
    const item = getInboxItem(db, existingRow.id);
    if (!item) throw new Error("Updated inbox item could not be read.");
    return { previous, item, changed: true, inserted: false };
  });
  return transaction.immediate();
}

export function hasInboxHumanResolution(db: Database.Database, itemId: string): boolean {
  return Boolean(db.prepare(`
    SELECT 1 FROM inbox_item_actions
    WHERE inbox_item_id = ? AND action_type = 'resolve' LIMIT 1
  `).get(itemId));
}

export function getInboxSessionItems(
  db: Database.Database,
  hostUrl: string,
  cardId?: string,
): InboxItem[] {
  const rows = db.prepare(`
    SELECT * FROM inbox_items
    WHERE json_extract(briefing_json, '$.provenance.hostUrl') = ?
      AND json_extract(briefing_json, '$.provenance.sourceType') = 'ahp-session'
      AND card_id IS NOT NULL
      ${cardId === undefined ? "" : "AND card_id = ?"}
  `).all(...(cardId === undefined ? [hostUrl] : [hostUrl, cardId])) as InboxItemRow[];
  return rows.map(mapItem);
}

export function observeInboxSource(
  db: Database.Database,
  item: InboxItem,
  identity: Pick<InboxBriefing["provenance"], "sessionTitle" | "projectName" | "workspacePath">,
  sourceObservedAt?: string,
): InboxMutation {
  const briefing: InboxBriefing = {
    ...item.briefing,
    provenance: {
      ...item.briefing.provenance,
      ...Object.fromEntries(Object.entries(identity).filter(([, value]) => value !== undefined)),
    },
    freshness: {
      ...item.briefing.freshness,
      sourceObservedAt: sourceObservedAt ?? item.briefing.freshness.sourceObservedAt,
    },
  };
  if (JSON.stringify(briefing) === JSON.stringify(item.briefing)) {
    return { previous: item, item, changed: false, inserted: false };
  }
  db.prepare("UPDATE inbox_items SET briefing_json = ? WHERE id = ?")
    .run(JSON.stringify(briefing), item.id);
  return { previous: item, item: { ...item, briefing }, changed: true, inserted: false };
}

export function updateInboxPresentationIfCurrent(
  db: Database.Database,
  sourceKey: string,
  sourceRevision: string,
  requestId: string,
  update: (item: InboxItem) => InboxPresentationUpdate,
): InboxMutation | null {
  const transaction = db.transaction((): InboxMutation | null => {
    const row = getItemRowBySourceKey(db, sourceKey);
    if (!row) return null;
    const previous = mapItem(row);
    if (
      previous.workflowState !== "open" ||
      previous.sourceRevision !== sourceRevision ||
      previous.briefing.synthesis?.requestId !== requestId
    ) {
      return null;
    }

    const presentation = update(previous);
    const briefingJson = JSON.stringify(presentation.briefing);
    if (
      previous.title === presentation.title &&
      row.briefing_json === briefingJson
    ) {
      return {
        previous,
        item: previous,
        changed: false,
        inserted: false,
      };
    }

    db.prepare(`
      UPDATE inbox_items
      SET title = ?, briefing_json = ?
      WHERE id = ?
    `).run(presentation.title, briefingJson, previous.id);
    const item = getInboxItem(db, previous.id);
    if (!item) throw new Error("Refreshed inbox presentation could not be read.");
    return { previous, item, changed: true, inserted: false };
  });
  return transaction.immediate();
}

export function resolveInboxSource(
  db: Database.Database,
  sourceKey: string,
  now = new Date().toISOString(),
): InboxMutation | null {
  const row = getItemRowBySourceKey(db, sourceKey);
  if (!row) return null;
  const previous = mapItem(row);
  if (previous.workflowState === "resolved") {
    return { previous, item: previous, changed: false, inserted: false };
  }
  db.prepare(`
    UPDATE inbox_items
    SET workflow_state = 'resolved', resolved_at = ?, snoozed_until = NULL,
        updated_at = ?
    WHERE id = ? AND workflow_state <> 'resolved'
  `).run(now, now, row.id);
  const item = getInboxItem(db, row.id);
  if (!item) throw new Error("Resolved inbox item could not be read.");
  return { previous, item, changed: true, inserted: false };
}

export function resolveInboxKind(
  db: Database.Database,
  kind: InboxItemKind,
  cardId: string | null,
  exceptSourceKey: string | undefined,
  hostUrl?: string,
  now = new Date().toISOString(),
): InboxMutation[] {
  const clauses = [
    "kind = ?",
    cardId === null ? "card_id IS NULL" : "card_id = ?",
    "workflow_state <> 'resolved'",
  ];
  const args: unknown[] = [kind];
  if (cardId !== null) args.push(cardId);
  if (hostUrl) {
    clauses.push("json_extract(briefing_json, '$.provenance.hostUrl') = ?");
    args.push(hostUrl);
  }
  if (exceptSourceKey) {
    clauses.push("source_key <> ?");
    args.push(exceptSourceKey);
  }
  const rows = db.prepare(`
    SELECT * FROM inbox_items
    WHERE ${clauses.join(" AND ")}
    ORDER BY id
  `).all(...args) as InboxItemRow[];

  return rows.map((row) => {
    const previous = mapItem(row);
    db.prepare(`
      UPDATE inbox_items
      SET workflow_state = 'resolved', resolved_at = ?, snoozed_until = NULL,
          updated_at = ?
      WHERE id = ? AND workflow_state <> 'resolved'
    `).run(now, now, row.id);
    const item = getInboxItem(db, row.id);
    if (!item) throw new Error("Resolved inbox item could not be read.");
    return { previous, item, changed: true, inserted: false };
  });
}

export function purgeNonActionableInboxItems(
  db: Database.Database,
  hostUrl?: string,
  now = new Date().toISOString(),
  completionMaxAgeMs = 60 * 60 * 1000,
): number {
  const hostClause = hostUrl
    ? "AND json_extract(briefing_json, '$.provenance.hostUrl') = ?"
    : "";
  const completionCutoff = new Date(
    new Date(now).getTime() - completionMaxAgeMs,
  ).toISOString();
  const args = hostUrl ? [hostUrl, completionCutoff] : [completionCutoff];
  const result = db.prepare(`
    DELETE FROM inbox_items
    WHERE 1 = 1
      ${hostClause}
      AND NOT EXISTS (
        SELECT 1 FROM inbox_item_actions
        WHERE inbox_item_id = inbox_items.id
      )
      AND (
        (
          workflow_state = 'resolved'
        )
        OR (
          workflow_state = 'open'
          AND (
            source_key LIKE '%:escalation:source-revision-required'
            OR source_key LIKE '%:escalation:risk-assessment-required'
            OR source_key LIKE 'orchestrator:wip:%'
            OR source_key LIKE '%:orchestrator:wip:%'
          )
        )
        OR (
          workflow_state = 'open'
          AND kind IN ('completion', 'review-ready', 'ship-ready')
          AND json_type(
            briefing_json,
            '$.freshness.sourceModifiedAt'
          ) = 'text'
          AND ABS(
            strftime('%s', created_at) -
            strftime(
              '%s',
              json_extract(
                briefing_json,
                '$.freshness.sourceModifiedAt'
              )
            )
          ) > 600
        )
        OR (
          workflow_state = 'open'
          AND kind = 'completion'
          AND pinned_at IS NULL
          AND created_at < ?
        )
      )
  `).run(...args);
  return result.changes;
}

export function refreshLegacyInboxPresentation(
  db: Database.Database,
  options: { hostUrl?: string } = {},
): number {
  const hostClause = options.hostUrl
    ? `AND (
         json_type(briefing_json, '$.provenance.hostUrl') IS NULL
         OR json_extract(briefing_json, '$.provenance.hostUrl') = ?
       )`
    : "";
  const args = options.hostUrl ? [options.hostUrl] : [];
  const rows = db.prepare(`
    SELECT * FROM inbox_items
    WHERE workflow_state = 'open'
      ${hostClause}
      AND (
        kind = 'completion'
        OR source_key LIKE 'orchestrator:wip:%'
        OR source_key LIKE 'host:%:orchestrator:wip:%'
      )
  `).all(...args) as InboxItemRow[];

  let changes = 0;
  const update = db.prepare(`
    UPDATE inbox_items
    SET briefing_json = ?
    WHERE id = ?
  `);
  const transaction = db.transaction(() => {
    for (const row of rows) {
      const briefing = parseJson<InboxBriefing>(
        row.briefing_json,
        "briefing",
      );
      const next = { ...briefing };
      if (
        row.kind === "completion" &&
        briefing.reason === "The agent finished its active work."
      ) {
        next.reason = briefing.outcome;
        next.recommendation = "";
      } else if (briefing.provenance.eventType === "wip-violation") {
        next.recommendation = "";
        next.reason = briefing.reason.replace(
          /^(\d+) cards are in /,
          "$1 active cards are in ",
        );
        if (
          next.recommendation === briefing.recommendation &&
          next.reason === briefing.reason
        ) {
          continue;
        }
      } else {
        continue;
      }
      changes += update.run(JSON.stringify(next), row.id).changes;
    }
  });
  transaction.immediate();
  return changes;
}

export function listInboxItems(
  db: Database.Database,
  query: InboxListQuery = {},
): InboxListResult {
  const clauses: string[] = [];
  const args: unknown[] = [];
  const workflowState = query.workflowState ?? "open";
  if (workflowState !== "all") {
    clauses.push("workflow_state = ?");
    args.push(workflowState);
  }

  if (query.readState && query.readState !== "all") {
    clauses.push("read_state = ?");
    args.push(query.readState);
  }
  if (query.kind) {
    clauses.push("kind = ?");
    args.push(query.kind);
  }
  if (query.cardId) {
    clauses.push("card_id = ?");
    args.push(query.cardId);
  }
  if (query.hostUrl) {
    clauses.push("json_extract(briefing_json, '$.provenance.hostUrl') = ?");
    args.push(query.hostUrl);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const total = (
    db.prepare(`SELECT count(*) AS count FROM inbox_items ${where}`)
      .get(...args) as { count: number }
  ).count;
  const limit = Math.min(Math.max(query.limit ?? 100, 1), 500);
  const rows = db.prepare(`
    SELECT * FROM inbox_items
    ${where}
    ORDER BY priority_rank DESC, updated_at DESC, id ASC
    LIMIT ?
  `).all(...args, limit) as InboxItemRow[];
  return { items: rows.map(mapItem), total };
}

export function getInboxCounts(
  db: Database.Database,
  hostUrl?: string,
): InboxCounts {
  const hostClause = hostUrl
    ? "WHERE json_extract(briefing_json, '$.provenance.hostUrl') = ?"
    : "";
  const args = hostUrl ? [hostUrl] : [];
  const row = db.prepare(`
    SELECT
      SUM(CASE
        WHEN workflow_state = 'open' AND (
          priority_rank >= 280
          OR kind = 'review-ready'
          OR (
            kind IN ('completion', 'coordinator-action')
            AND read_state = 'unread'
          )
          OR json_extract(briefing_json, '$.synthesis.attention') = 'now'
        ) THEN 1 ELSE 0
      END) AS priority,
      SUM(CASE
        WHEN workflow_state = 'open' AND read_state = 'unread' THEN 1 ELSE 0
      END) AS unread,
      SUM(CASE WHEN workflow_state = 'open' THEN 1 ELSE 0 END) AS open,
      SUM(CASE
        WHEN workflow_state = 'dismissed' AND snoozed_until IS NOT NULL
        THEN 1 ELSE 0
      END) AS snoozed,
      SUM(CASE
        WHEN workflow_state = 'resolved'
          OR (workflow_state = 'dismissed' AND snoozed_until IS NULL)
        THEN 1 ELSE 0
      END) AS done
    FROM inbox_items
    ${hostClause}
  `).get(...args) as Record<keyof InboxCounts, number | null>;
  return {
    priority: row.priority ?? 0,
    unread: row.unread ?? 0,
    open: row.open ?? 0,
    snoozed: row.snoozed ?? 0,
    done: row.done ?? 0,
  };
}

export function applyInboxAction(
  db: Database.Database,
  itemId: string,
  actionType: InboxActionType,
  note: string | null,
  snoozedUntil: string | null,
  now = new Date().toISOString(),
): { item: InboxItem; action: InboxItemAction } | null {
  if (!(INBOX_ACTION_TYPES as readonly string[]).includes(actionType)) {
    throw new Error(`Unsupported inbox action: ${actionType}`);
  }

  const transaction = db.transaction(() => {
    const previous = getInboxItem(db, itemId);
    if (!previous) return null;

    let nextWorkflowState = previous.workflowState;
    let nextReadState = previous.readState;
    let nextPinnedAt = previous.pinnedAt;
    let nextSnoozedUntil = previous.snoozedUntil;
    switch (actionType) {
      case "read":
        nextReadState = "read";
        break;
      case "unread":
        nextReadState = "unread";
        break;
      case "resolve":
        nextWorkflowState = "resolved";
        nextSnoozedUntil = null;
        break;
      case "snooze":
        if (!snoozedUntil) {
          throw new Error("snoozedUntil is required for a snooze action.");
        }
        nextWorkflowState = "dismissed";
        nextSnoozedUntil = snoozedUntil;
        break;
      case "unsnooze":
        nextWorkflowState = "open";
        nextSnoozedUntil = null;
        break;
      case "pin":
        nextPinnedAt = previous.pinnedAt ?? now;
        break;
      case "unpin":
        nextPinnedAt = null;
        break;
    }

    const readAt = nextReadState === "read"
      ? previous.readAt ?? now
      : null;
    const resolvedAt = nextWorkflowState === "open"
      ? null
      : previous.resolvedAt ?? now;
    db.prepare(`
      UPDATE inbox_items
      SET workflow_state = ?, read_state = ?, read_at = ?, resolved_at = ?,
          pinned_at = ?, snoozed_until = ?, updated_at = ?
      WHERE id = ?
    `).run(
      nextWorkflowState,
      nextReadState,
      readAt,
      resolvedAt,
      nextPinnedAt,
      nextSnoozedUntil,
      now,
      itemId,
    );
    const result = db.prepare(`
      INSERT INTO inbox_item_actions (
        inbox_item_id, action_type, actor, note,
        previous_workflow_state, next_workflow_state,
        previous_read_state, next_read_state, snoozed_until, created_at
      )
      VALUES (?, ?, 'local-human', ?, ?, ?, ?, ?, ?, ?)
    `).run(
      itemId,
      actionType,
      note,
      previous.workflowState,
      nextWorkflowState,
      previous.readState,
      nextReadState,
      nextSnoozedUntil,
      now,
    );
    const item = getInboxItem(db, itemId);
    if (!item) throw new Error("Mutated inbox item could not be read.");
    const actionRow = db.prepare(
      "SELECT * FROM inbox_item_actions WHERE id = ?",
    ).get(Number(result.lastInsertRowid)) as InboxActionRow | undefined;
    if (!actionRow) throw new Error("Recorded inbox action could not be read.");
    return { item, action: mapAction(actionRow) };
  });
  return transaction.immediate();
}
