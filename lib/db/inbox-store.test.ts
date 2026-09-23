import assert from "node:assert/strict";
import test from "node:test";

import Database from "better-sqlite3";

import type { InboxItemDraft } from "../inbox/types.ts";
import { ensureInboxSchema } from "./inbox-schema.ts";
import {
  applyInboxAction,
  getInboxCounts,
  getInboxItemBySourceKey,
  listInboxItems,
  purgeNonActionableInboxItems,
  refreshLegacyInboxPresentation,
  resolveInboxSource,
  updateInboxPresentationIfCurrent,
  upsertInboxItem,
} from "./inbox-store.ts";

function openDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  ensureInboxSchema(db);
  return db;
}

function itemDraft(
  sourceKey: string,
  sourceRevision: string,
  kind: InboxItemDraft["kind"] = "completion",
): InboxItemDraft {
  const observedAt = "2026-09-22T00:00:00.000Z";
  return {
    sourceKey,
    sourceRevision,
    kind,
    cardId: "card-1",
    title: "Agent task completed",
    briefing: {
      recommendation: "Inspect the outcome.",
      reason: "The agent stopped running.",
      alternativeActions: [{ id: "inspect", label: "Inspect" }],
      outcome: "Research was produced.",
      caveats: ["No code changes were detected."],
      confidence: "high",
      freshness: { observedAt },
      provenance: {
        sourceType: "ahp-session",
        sourceKey,
        eventType: "session-idle",
        cardId: "card-1",
        sourceRevision,
      },
    },
  };
}

test("source-key upserts dedupe and reopen only for a new revision", () => {
  const db = openDb();
  try {
    const first = upsertInboxItem(
      db,
      itemDraft("session:card-1:completion:one", "revision-1"),
      "2026-09-22T00:00:00.000Z",
    );
    assert.equal(first.inserted, true);
    assert.equal(first.item.readState, "unread");

    const duplicate = upsertInboxItem(
      db,
      itemDraft("session:card-1:completion:one", "revision-1"),
      "2026-09-22T00:01:00.000Z",
    );
    assert.equal(duplicate.changed, false);
    assert.equal(duplicate.item.id, first.item.id);
    assert.equal(duplicate.item.updatedAt, first.item.updatedAt);

    const read = applyInboxAction(
      db,
      first.item.id,
      "read",
      null,
      null,
      "2026-09-22T00:02:00.000Z",
    );
    assert.equal(read?.item.readState, "read");
    const resolved = applyInboxAction(
      db,
      first.item.id,
      "resolve",
      "Handled",
      null,
      "2026-09-22T00:03:00.000Z",
    );
    assert.equal(resolved?.item.workflowState, "resolved");
    assert.equal(resolved?.item.readState, "read");

    const refreshedDraft = itemDraft(
      "session:card-1:completion:one",
      "revision-1",
    );
    refreshedDraft.title = "Research completed";
    refreshedDraft.briefing.recommendation = "";
    const refreshed = upsertInboxItem(
      db,
      refreshedDraft,
      "2026-09-22T00:03:30.000Z",
    );
    assert.equal(refreshed.changed, true);
    assert.equal(refreshed.item.title, "Research completed");
    assert.equal(refreshed.item.briefing.recommendation, "");
    assert.equal(refreshed.item.workflowState, "resolved");
    assert.equal(refreshed.item.readState, "read");
    assert.equal(refreshed.item.updatedAt, resolved?.item.updatedAt);

    const reopened = upsertInboxItem(
      db,
      itemDraft("session:card-1:completion:one", "revision-2"),
      "2026-09-22T00:04:00.000Z",
    );
    assert.equal(reopened.inserted, false);
    assert.equal(reopened.changed, true);
    assert.equal(reopened.item.workflowState, "open");
    assert.equal(reopened.item.readState, "unread");
    assert.equal(reopened.item.readAt, null);
    assert.equal(reopened.item.resolvedAt, null);

    const actions = db.prepare(`
      SELECT action_type, previous_workflow_state, next_workflow_state,
             previous_read_state, next_read_state
      FROM inbox_item_actions ORDER BY id
    `).all();
    assert.deepEqual(actions, [
      {
        action_type: "read",
        previous_workflow_state: "open",
        next_workflow_state: "open",
        previous_read_state: "unread",
        next_read_state: "read",
      },
      {
        action_type: "resolve",
        previous_workflow_state: "open",
        next_workflow_state: "resolved",
        previous_read_state: "read",
        next_read_state: "read",
      },
    ]);
  } finally {
    db.close();
  }
});

test("generated presentation refresh is revision-safe and preserves human state", () => {
  const db = openDb();
  try {
    const draft = itemDraft("completion", "revision-1", "completion");
    draft.briefing.synthesis = {
      status: "pending",
      requestId: "request-1",
    };
    const inserted = upsertInboxItem(
      db,
      draft,
      "2026-09-22T00:00:00.000Z",
    ).item;
    const read = applyInboxAction(
      db,
      inserted.id,
      "read",
      null,
      null,
      "2026-09-22T00:01:00.000Z",
    );
    assert.ok(read);

    const refreshed = updateInboxPresentationIfCurrent(
      db,
      "completion",
      "revision-1",
      "request-1",
      (current) => ({
        title: "The research is ready",
        briefing: {
          ...current.briefing,
          message: "The findings are complete; no follow-up is needed.",
          synthesis: {
            status: "generated",
            attention: "routine",
            requestId: "request-1",
            model: "test-model",
            generatedAt: "2026-09-22T00:02:00.000Z",
          },
        },
      }),
    );
    assert.equal(refreshed?.item.title, "The research is ready");
    assert.equal(refreshed?.item.readState, "read");
    assert.equal(refreshed?.item.readAt, read.item.readAt);
    assert.equal(refreshed?.item.updatedAt, read.item.updatedAt);

    resolveInboxSource(
      db,
      "completion",
      "2026-09-22T00:03:00.000Z",
    );
    assert.equal(
      updateInboxPresentationIfCurrent(
        db,
        "completion",
        "revision-1",
        "request-1",
        (current) => ({
          title: "Stale result",
          briefing: current.briefing,
        }),
      ),
      null,
    );
    assert.equal(
      getInboxItemBySourceKey(db, "completion")?.title,
      "The research is ready",
    );
  } finally {
    db.close();
  }
});

test("read state is independent from workflow state and list filters", () => {
  const db = openDb();
  try {
    const item = upsertInboxItem(
      db,
      itemDraft("session:card-1:error", "error-1", "runtime-error"),
    ).item;
    applyInboxAction(db, item.id, "read", null, null);
    applyInboxAction(
      db,
      item.id,
      "snooze",
      null,
      "2026-09-22T01:00:00.000Z",
      "2026-09-22T00:10:00.000Z",
    );

    const stored = getInboxItemBySourceKey(db, "session:card-1:error");
    assert.equal(stored?.workflowState, "dismissed");
    assert.equal(stored?.readState, "read");
    assert.equal(stored?.snoozedUntil, "2026-09-22T01:00:00.000Z");
    assert.equal(listInboxItems(db).total, 0);
    assert.equal(
      listInboxItems(db, {
        workflowState: "dismissed",
        readState: "read",
      }).total,
      1,
    );
    const projectedResolution = resolveInboxSource(
      db,
      "session:card-1:error",
      "2026-09-22T00:20:00.000Z",
    );
    assert.equal(projectedResolution?.item.workflowState, "resolved");
    assert.equal(projectedResolution?.item.readState, "read");
  } finally {
    db.close();
  }
});

test("items are deterministically ordered by kind priority then freshness", () => {
  const db = openDb();
  try {
    upsertInboxItem(
      db,
      itemDraft("completion", "1", "completion"),
      "2026-09-22T00:03:00.000Z",
    );
    upsertInboxItem(
      db,
      itemDraft("pending", "1", "pending-input"),
      "2026-09-22T00:02:00.000Z",
    );
    upsertInboxItem(
      db,
      itemDraft("error", "1", "runtime-error"),
      "2026-09-22T00:01:00.000Z",
    );

    const result = listInboxItems(db);
    assert.deepEqual(
      result.items.map(({ sourceKey, priorityBand, priorityRank }) => ({
        sourceKey,
        priorityBand,
        priorityRank,
      })),
      [
        { sourceKey: "error", priorityBand: "urgent", priorityRank: 400 },
        { sourceKey: "pending", priorityBand: "high", priorityRank: 300 },
        { sourceKey: "completion", priorityBand: "normal", priorityRank: 190 },
      ],
    );
  } finally {
    db.close();
  }
});

test("priority counts include unread read-only briefings", () => {
  const db = openDb();
  try {
    const completion = upsertInboxItem(
      db,
      itemDraft("completion", "1", "completion"),
    ).item;
    upsertInboxItem(
      db,
      itemDraft("pending", "1", "pending-input"),
    );
    upsertInboxItem(
      db,
      itemDraft("review", "1", "review-ready"),
    );

    assert.equal(getInboxCounts(db).priority, 3);
    applyInboxAction(db, completion.id, "read", null, null);
    assert.equal(getInboxCounts(db).priority, 2);
    const promoted = itemDraft("promoted-completion", "1", "completion");
    promoted.briefing.synthesis = {
      status: "generated",
      attention: "now",
      requestId: "request-now",
    };
    const promotedItem = upsertInboxItem(db, promoted).item;
    applyInboxAction(db, promotedItem.id, "read", null, null);
    assert.equal(getInboxCounts(db).priority, 3);
  } finally {
    db.close();
  }
});

test("purges internal diagnostics and startup backfill without deleting new work", () => {
  const db = openDb();
  try {
    const backfill = itemDraft("old-completion", "1", "completion");
    backfill.briefing.freshness.sourceModifiedAt =
      "2026-09-20T00:00:00.000Z";
    upsertInboxItem(db, backfill, "2026-09-22T00:00:00.000Z");

    const current = itemDraft("new-completion", "1", "completion");
    current.briefing.freshness.sourceModifiedAt =
      "2026-09-22T00:00:00.000Z";
    upsertInboxItem(db, current, "2026-09-22T00:05:00.000Z");

    upsertInboxItem(
      db,
      itemDraft(
        "card:card-1:escalation:source-revision-required",
        "1",
        "review-escalation",
      ),
      "2026-09-22T00:05:00.000Z",
    );
    upsertInboxItem(
      db,
      itemDraft(
        "orchestrator:wip:build",
        "1",
        "review-escalation",
      ),
      "2026-09-22T00:05:00.000Z",
    );
    upsertInboxItem(
      db,
      itemDraft(
        "host:vscode-local%3A%2F%2Fdesktop:orchestrator:wip:review",
        "1",
        "review-escalation",
      ),
      "2026-09-22T00:05:00.000Z",
    );
    const expired = itemDraft("expired-completion", "1", "completion");
    expired.briefing.freshness.sourceModifiedAt =
      "2026-09-21T22:00:00.000Z";
    upsertInboxItem(db, expired, "2026-09-21T22:00:00.000Z");
    const pinned = upsertInboxItem(
      db,
      itemDraft("pinned-completion", "1", "completion"),
      "2026-09-21T22:00:00.000Z",
    ).item;
    applyInboxAction(
      db,
      pinned.id,
      "pin",
      null,
      null,
      "2026-09-21T22:05:00.000Z",
    );

    assert.equal(
      purgeNonActionableInboxItems(
        db,
        undefined,
        "2026-09-22T00:30:00.000Z",
      ),
      5,
    );
    assert.deepEqual(
      listInboxItems(db).items.map((item) => item.sourceKey),
      ["new-completion", "pinned-completion"],
    );
  } finally {
    db.close();
  }
});

test("refreshes legacy copy without changing inbox state", () => {
  const db = openDb();
  try {
    const legacyDraft = itemDraft(
      "session:card-1:completion:one",
      "revision-1",
    );
    legacyDraft.briefing.recommendation =
      "Inspect the outcome and decide whether any follow-up is needed.";
    legacyDraft.briefing.reason = "The agent finished its active work.";
    const completion = upsertInboxItem(
      db,
      legacyDraft,
      "2026-09-22T00:00:00.000Z",
    ).item;
    const wipDraft = itemDraft(
      "orchestrator:wip:build",
      "build:7:3",
      "review-escalation",
    );
    wipDraft.briefing.provenance.eventType = "wip-violation";
    wipDraft.briefing.recommendation = "Review session.";
    wipDraft.briefing.reason =
      "7 cards are in build; the configured limit is 3.";
    upsertInboxItem(db, wipDraft, "2026-09-22T00:00:00.000Z");
    const read = applyInboxAction(
      db,
      completion.id,
      "read",
      null,
      null,
      "2026-09-22T00:01:00.000Z",
    );

    assert.equal(refreshLegacyInboxPresentation(db), 2);
    const refreshed = getInboxItemBySourceKey(
      db,
      "session:card-1:completion:one",
    );
    assert.equal(refreshed?.briefing.recommendation, "");
    assert.equal(refreshed?.briefing.reason, "Research was produced.");
    assert.equal(refreshed?.readState, "read");
    assert.equal(refreshed?.workflowState, "open");
    assert.equal(refreshed?.updatedAt, read?.item.updatedAt);
    const wip = getInboxItemBySourceKey(db, "orchestrator:wip:build");
    assert.equal(wip?.briefing.recommendation, "");
    assert.equal(
      wip?.briefing.reason,
      "7 active cards are in build; the configured limit is 3.",
    );
    assert.equal(refreshLegacyInboxPresentation(db), 0);
  } finally {
    db.close();
  }
});
