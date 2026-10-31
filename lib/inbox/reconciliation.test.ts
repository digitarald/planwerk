import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { AHPStatus, type AHPSessionSummary } from "../ahp/types.ts";
import { ensureInboxSchema } from "../db/inbox-schema.ts";
import {
  applyInboxAction, getInboxItemBySourceKey, listInboxItems,
  purgeNonActionableInboxItems, upsertInboxItem,
} from "../db/inbox-store.ts";
import { reconcileInboxCatalog, type InboxCatalogEntry } from "./reconciliation.ts";
import type { InboxItemDraft, InboxItemKind } from "./types.ts";

const host = "ws://test";
const now = "2026-09-22T00:00:00.000Z";
function source(resource: string, status: number = AHPStatus.Idle, enabled = true): InboxCatalogEntry {
  return {
    session: {
      resource, title: `Title ${resource}`, status, provider: "test",
      createdAt: now, modifiedAt: now,
      project: { name: "Project", path: "/project" },
    } satisfies AHPSessionSummary,
    enabled,
  };
}
function draft(cardId: string, kind: InboxItemKind = "pending-input", hostUrl = host): InboxItemDraft {
  const sourceKey = `${hostUrl}:${cardId}:${kind}`;
  return {
    sourceKey, sourceRevision: "1", kind, cardId, title: "Generated headline",
    briefing: {
      recommendation: "", reason: "A question", alternativeActions: [], outcome: "",
      caveats: [], confidence: "high", freshness: { observedAt: now },
      provenance: { sourceType: "ahp-session", sourceKey, hostUrl, cardId, eventType: kind },
    },
  };
}

test("only complete live inventories reconcile missing, disabled, archived and resolved sources", () => {
  const db = new Database(":memory:");
  ensureInboxSchema(db);
  try {
    const fixtures = [
      draft("missing"), draft("disabled"), draft("archived"), draft("idle"),
      draft("waiting"), draft("clear-error", "runtime-error"),
      draft("error", "runtime-error"), draft("archived", "review-ready"),
      draft("archived", "ship-ready"), draft("archived", "completion"),
      draft("disabled", "completion"), draft("quarantined"), draft("missing", "pending-input", "ws://other"),
    ];
    for (const item of fixtures) upsertInboxItem(db, item, now);
    const entries = [
      source("disabled", AHPStatus.InputNeeded, false),
      source("archived", AHPStatus.IsArchived | AHPStatus.InputNeeded),
      source("idle"), source("waiting", AHPStatus.InputNeeded | AHPStatus.IsRead),
      source("clear-error"), source("error", AHPStatus.Error),
    ];
    assert.deepEqual(reconcileInboxCatalog(db, host, entries, { complete: false }), []);
    assert.equal(listInboxItems(db).total, fixtures.length);
    const options = { complete: true, now, ownsSession: (id: string) => id !== "quarantined" };
    reconcileInboxCatalog(db, host, entries, options);
    assert.deepEqual(listInboxItems(db).items.map((item) => `${item.briefing.provenance.hostUrl}:${item.cardId}:${item.kind}`).sort(), [
      `${host}:archived:completion`, `${host}:waiting:pending-input`,
      `${host}:error:runtime-error`, `${host}:quarantined:pending-input`,
      "ws://other:missing:pending-input",
    ].sort());
    assert.equal(reconcileInboxCatalog(db, host, entries, options).some((mutation) => mutation.changed), false);
    const waiting = getInboxItemBySourceKey(db, draft("waiting").sourceKey)!;
    assert.equal(waiting.briefing.provenance.sessionTitle, "Title waiting");
    assert.equal(waiting.briefing.freshness.sourceObservedAt, undefined);
  } finally { db.close(); }
});

test("metadata refresh preserves human history, ordering and durable identity when project is absent", () => {
  const db = new Database(":memory:");
  ensureInboxSchema(db);
  try {
    const input = draft("waiting");
    const initial = upsertInboxItem(db, input, now).item;
    applyInboxAction(db, initial.id, "read", null, null, now);
    applyInboxAction(db, initial.id, "pin", null, null, now);
    const before = getInboxItemBySourceKey(db, input.sourceKey)!;
    reconcileInboxCatalog(db, host, [source("waiting", AHPStatus.InputNeeded)], { complete: true, now });
    const entry = source("waiting", AHPStatus.InputNeeded);
    delete entry.session.project;
    reconcileInboxCatalog(db, host, [entry], { complete: true, now });
    const refreshed = getInboxItemBySourceKey(db, input.sourceKey)!;
    assert.equal(refreshed.briefing.provenance.workspacePath, "/project");
    assert.equal(refreshed.title, "Generated headline");
    assert.equal(refreshed.updatedAt, before.updatedAt);
    assert.equal(refreshed.readAt, before.readAt);
    assert.equal(refreshed.pinnedAt, before.pinnedAt);
    reconcileInboxCatalog(db, host, [], { complete: true, now });
    purgeNonActionableInboxItems(db, host, "2026-09-23T00:00:00Z");
    assert.equal(getInboxItemBySourceKey(db, input.sourceKey)?.workflowState, "resolved");
    assert.equal(db.prepare("SELECT count(*) FROM inbox_item_actions").pluck().get(), 2);
  } finally { db.close(); }
});

test("single-source reconciliation leaves other sessions alone and covers beyond list limits", () => {
  const db = new Database(":memory:");
  ensureInboxSchema(db);
  try {
    db.transaction(() => {
      for (let index = 0; index < 1100; index++) upsertInboxItem(db, draft(`session-${index}`), now);
    })();
    reconcileInboxCatalog(db, host, [], { complete: true, cardId: "session-1099", now });
    assert.equal(listInboxItems(db).total, 1099);
    reconcileInboxCatalog(db, host, [], { complete: true, now });
    assert.equal(listInboxItems(db).total, 0);
  } finally { db.close(); }
});
