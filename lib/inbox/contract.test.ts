import assert from "node:assert/strict";
import test from "node:test";

import type { InboxItem } from "./types.ts";
import {
  inboxItemMatchesHost,
  serializeInboxActionResponse,
  serializeInboxItem,
  serializeInboxListResponse,
} from "./contract.ts";

test("API serialization matches the frontend briefing contract", () => {
  const item: InboxItem = {
    id: "item-1",
    sourceKey: "session:card-1:pending-input:request-1",
    sourceRevision: "revision-1",
    kind: "pending-input",
    priorityBand: "high",
    priorityRank: 300,
    workflowState: "open",
    readState: "unread",
    cardId: "card-1",
    relatedCardIds: [],
    title: "Task needs input",
    briefing: {
      message: "The agent needs a deployment choice before it can continue.",
      recommendation: "Review and reply.",
      reason: "The agent asked a question.",
      recommendedAction: {
        id: "cos-reply",
        label: "Choose target",
        intent: "reply",
      },
      alternativeActions: [{
        id: "inspect-session",
        label: "Inspect session",
      }],
      outcome: "The agent can continue.",
      caveats: ["The inbox does not answer automatically."],
      confidence: "high",
      synthesis: {
        status: "generated",
        attention: "now",
        requestId: "request-1",
        model: "test-model",
        generatedAt: "2026-09-22T00:00:00.000Z",
      },
      freshness: { observedAt: "2026-09-22T00:00:00.000Z" },
      provenance: {
        sourceType: "ahp-session",
        sourceKey: "session:card-1:pending-input:request-1",
        eventType: "pending-input",
        cardId: "card-1",
        sourceRevision: "revision-1",
      },
    },
    createdAt: "2026-09-22T00:00:00.000Z",
    updatedAt: "2026-09-22T00:00:00.000Z",
    readAt: null,
    resolvedAt: null,
    pinnedAt: null,
    snoozedUntil: null,
  };

  const serialized = serializeInboxItem(
    item,
    Date.parse("2026-09-22T00:05:00.000Z"),
  );
  assert.equal(serialized.sourceKind, "pending-input");
  assert.equal(serialized.category, "action");
  assert.equal(serialized.priorityBand, 2);
  assert.equal(serialized.priorityScore, 320);
  assert.equal(serialized.briefing.message, item.briefing.message);
  assert.equal(serialized.briefing.recommendationReason, item.briefing.reason);
  assert.equal(serialized.briefing.defaultAction.kind, "reply");
  assert.equal(serialized.briefing.defaultAction.label, "Choose target");
  assert.equal(serialized.briefing.attention, "now");
  assert.equal(serialized.briefing.synthesisStatus, "generated");
  assert.equal(
    serialized.briefing.alternativeActions.every(
      (action) => typeof action.kind === "string",
    ),
    true,
  );
  assert.equal(serialized.briefing.freshness.stale, false);
  assert.equal(serialized.readAt, null);

  const counts = {
    priority: 1,
    unread: 1,
    open: 1,
    snoozed: 0,
    done: 0,
  };
  const listResponse = serializeInboxListResponse([item], counts);
  assert.deepEqual(Object.keys(listResponse), ["items", "counts"]);
  assert.deepEqual(listResponse.counts, counts);

  const actionResponse = serializeInboxActionResponse(item);
  assert.deepEqual(Object.keys(actionResponse), ["item"]);
  assert.doesNotMatch(JSON.stringify({
    listResponse,
    actionResponse,
  }), /"[^"]*_[^"]*":/);
  assert.equal(inboxItemMatchesHost(item, undefined), true);
  assert.equal(
    inboxItemMatchesHost(item, "ws://127.0.0.1:9000"),
    false,
  );
  item.briefing.provenance.hostUrl = "ws://127.0.0.1:9000";
  assert.equal(
    inboxItemMatchesHost(item, "ws://127.0.0.1:9000"),
    true,
  );
});
