import assert from "node:assert/strict";
import test from "node:test";

import { priorityForInboxKind } from "./priority.ts";
import { INBOX_ITEM_KINDS } from "./types.ts";

test("every inbox kind has a deterministic priority band and unique rank", () => {
  const priorities = INBOX_ITEM_KINDS.map(priorityForInboxKind);
  assert.equal(
    new Set(priorities.map(({ rank }) => rank)).size,
    INBOX_ITEM_KINDS.length,
  );
  assert.deepEqual(priorityForInboxKind("runtime-error"), {
    band: "urgent",
    rank: 400,
  });
  assert.deepEqual(priorityForInboxKind("coordinator-action"), {
    band: "low",
    rank: 100,
  });
});
