import assert from "node:assert/strict";
import test from "node:test";

import { groupDuplicateFeedItems } from "./feed-grouping.ts";
import type { FeedItem } from "../store/orchestrator-store.ts";

function item(overrides: Partial<FeedItem> = {}): FeedItem {
  return {
    id: "feed-1",
    type: "alert",
    message: "Risk assessment is missing.",
    timestamp: 10,
    ...overrides,
  };
}

test("groups exact repeated system messages under the newest event", () => {
  const grouped = groupDuplicateFeedItems([
    item({
      id: "newest",
      timestamp: 30,
      cardTitle: "First task",
      projectName: "alpha",
    }),
    item({
      id: "older",
      timestamp: 20,
      cardTitle: "Second task",
      projectName: "beta",
    }),
    item({ id: "oldest", timestamp: 10, cardTitle: "First task", projectName: "alpha" }),
  ]);

  assert.equal(grouped.length, 1);
  assert.equal(grouped[0]?.id, "newest");
  assert.equal(grouped[0]?.duplicateCount, 2);
  assert.deepEqual(grouped[0]?.duplicateContexts, [
    "First task · alpha",
    "Second task · beta",
  ]);
});

test("keeps distinct and interactive events separate", () => {
  const interactive = item({ id: "input", cardId: "card-input" });
  const grouped = groupDuplicateFeedItems(
    [
      item({ id: "risk" }),
      item({ id: "different", message: "Source revision is missing." }),
      interactive,
      item({ id: "user", type: "user" }),
    ],
    (candidate) => candidate.id === interactive.id,
  );

  assert.deepEqual(grouped.map(({ id }) => id), [
    "risk",
    "different",
    "input",
    "user",
  ]);
});
