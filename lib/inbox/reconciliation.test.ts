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
import { projectHeartbeatAction } from "./projector.ts";
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

function legacyHeartbeatDraft(cardId: string, kind: "gate-failure" | "review-escalation", hostUrl = host): InboxItemDraft {
  const action = kind === "gate-failure"
    ? { type: "gate-completed", cardId, gateType: "lint", status: "failed" } as const
    : { type: "plan-review-failed", cardId, reason: "Plan evidence missing" } as const;
  const [operation] = projectHeartbeatAction(action, undefined, { hostUrl, now });
  assert.equal(operation.type, "upsert");
  if (operation.type !== "upsert") throw new Error("Expected heartbeat notice");
  const item = operation.item;
  item.sourceKey = `${hostUrl}:${item.sourceKey}`;
  delete item.briefing.freshness.sourceObservedAt;
  return item;
}

test("legacy heartbeat notices reconcile by session linkage, not event producer", () => {
  const db = new Database(":memory:");
  ensureInboxSchema(db);
  const later = "2026-09-23T00:00:00.000Z";
  try {
    const fixtures = (["gate-failure", "review-escalation"] as const).flatMap((kind) =>
      ["active", "archived", "disabled", "missing", "quarantined"].map((id) =>
        legacyHeartbeatDraft(id, kind)));
    const otherHost = legacyHeartbeatDraft("missing", "gate-failure", "ws://other");
    const goal = { ...draft("goal", "coordinator-action"), cardId: undefined };
    goal.briefing.provenance.sourceType = "orchestrator";
    for (const item of [...fixtures, otherHost, goal]) upsertInboxItem(db, item, now);
    const entries = [
      source("active"), source("archived", AHPStatus.Idle | AHPStatus.IsArchived),
      source("disabled", AHPStatus.Idle, false),
    ];
    const options = { complete: true, now: later, ownsSession: (id: string) => id !== "quarantined" };
    reconcileInboxCatalog(db, host, entries, { ...options, complete: false });
    assert.equal(listInboxItems(db).total, 12);
    reconcileInboxCatalog(db, host, entries, options);
    assert.equal(listInboxItems(db).total, 6);
    for (const input of fixtures) {
      const current = getInboxItemBySourceKey(db, input.sourceKey)!;
      if (input.cardId === "active") {
        assert.equal(current.workflowState, "open");
        assert.equal(current.briefing.provenance.sessionTitle, "Title active");
        assert.equal(current.briefing.freshness.sourceObservedAt, now);
        assert.equal(current.updatedAt, now);
      } else {
        assert.equal(current.workflowState, input.cardId === "quarantined" ? "open" : "resolved");
      }
    }
    assert.equal(reconcileInboxCatalog(db, host, entries, options).some((mutation) => mutation.changed), false);
    assert.equal(getInboxItemBySourceKey(db, otherHost.sourceKey)?.workflowState, "open");
    assert.equal(getInboxItemBySourceKey(db, goal.sourceKey)?.workflowState, "open");
  } finally { db.close(); }
});

test("heartbeat metadata repair preserves human choices and never refreshes event evidence from the catalog", () => {
  const db = new Database(":memory:");
  ensureInboxSchema(db);
  try {
    for (const action of ["read", "pin", "snooze", "resolve"] as const) {
      const input = legacyHeartbeatDraft(action, "gate-failure");
      const initial = upsertInboxItem(db, input, now).item;
      applyInboxAction(db, initial.id, action, null, action === "snooze" ? "2099-01-01T00:00:00Z" : null, now);
      const before = getInboxItemBySourceKey(db, input.sourceKey)!;
      reconcileInboxCatalog(db, host, [source(action)], {
        complete: true, cardId: action, now: "2026-09-23T00:00:00.000Z",
      });
      const after = getInboxItemBySourceKey(db, input.sourceKey)!;
      assert.equal(after.briefing.provenance.sessionTitle, `Title ${action}`);
      assert.equal(after.briefing.freshness.sourceObservedAt, now);
      assert.equal(after.workflowState, before.workflowState);
      assert.equal(after.readAt, before.readAt);
      assert.equal(after.pinnedAt, before.pinnedAt);
      assert.equal(after.snoozedUntil, before.snoozedUntil);
      assert.equal(after.updatedAt, before.updatedAt);
    }
    assert.equal(db.prepare("SELECT count(*) FROM inbox_item_actions").pluck().get(), 4);
  } finally { db.close(); }
});

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
