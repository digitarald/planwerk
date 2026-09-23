import assert from "node:assert/strict";
import test from "node:test";

import { inboxEventMatchesHost } from "./events.ts";
import type { InboxStreamEvent } from "./types.ts";

const event = {
  type: "inboxRemoved",
  itemId: "item-1",
  workflowState: "resolved",
  hostUrl: "ws://127.0.0.1:9000",
} satisfies InboxStreamEvent;

test("inbox stream events stay scoped to their AHP host", () => {
  assert.equal(inboxEventMatchesHost(event, undefined), true);
  assert.equal(
    inboxEventMatchesHost(event, "ws://127.0.0.1:9000"),
    true,
  );
  assert.equal(
    inboxEventMatchesHost(event, "ws://127.0.0.1:9001"),
    false,
  );
});
