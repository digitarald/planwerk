import assert from "node:assert/strict";
import test from "node:test";

import Database from "better-sqlite3";

import { ensureInboxSchema } from "../db/inbox-schema.ts";
import {
  listInboxItems,
  resolveInboxKind,
  upsertInboxItem,
} from "../db/inbox-store.ts";
import { scopeInboxProjection } from "./projection-scope.ts";
import type { InboxProjectionOperation } from "./types.ts";

function completion(sourceRevision: string): InboxProjectionOperation {
  const sourceKey = "session:shared:completion";
  return {
    type: "upsert",
    item: {
      sourceKey,
      sourceRevision,
      kind: "completion",
      cardId: "shared",
      title: "Shared session completed",
      briefing: {
        recommendation: "Inspect the outcome.",
        reason: "The session completed.",
        alternativeActions: [],
        outcome: "Work completed.",
        caveats: [],
        confidence: "high",
        freshness: { observedAt: "2026-09-22T00:00:00.000Z" },
        provenance: {
          sourceType: "ahp-session",
          sourceKey,
          eventType: "session-idle",
          cardId: "shared",
          sourceRevision,
        },
      },
    },
  };
}

test("projections and resolutions stay isolated by AHP host", () => {
  const db = new Database(":memory:");
  ensureInboxSchema(db);
  try {
    const firstHost = "ws://127.0.0.1:9000";
    const secondHost = "ws://127.0.0.1:9001";
    const first = scopeInboxProjection(
      firstHost,
      completion("revision-1"),
    );
    const second = scopeInboxProjection(
      secondHost,
      completion("revision-1"),
    );
    assert.equal(first.type, "upsert");
    assert.equal(second.type, "upsert");
    if (first.type !== "upsert" || second.type !== "upsert") return;
    upsertInboxItem(db, first.item);
    upsertInboxItem(db, second.item);

    assert.equal(listInboxItems(db, {
      workflowState: "all",
      hostUrl: firstHost,
    }).total, 1);
    assert.equal(listInboxItems(db, {
      workflowState: "all",
      hostUrl: secondHost,
    }).total, 1);

    resolveInboxKind(
      db,
      "completion",
      "shared",
      undefined,
      firstHost,
    );

    assert.equal(listInboxItems(db, {
      workflowState: "open",
      hostUrl: firstHost,
    }).total, 0);
    assert.equal(listInboxItems(db, {
      workflowState: "open",
      hostUrl: secondHost,
    }).total, 1);
  } finally {
    db.close();
  }
});
