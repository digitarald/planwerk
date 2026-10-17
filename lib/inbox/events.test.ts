import assert from "node:assert/strict";
import test from "node:test";

import { inboxEventMatchesHost, inboxEvents } from "./events.ts";
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

test("a failed subscriber cannot prevent delivery to other listeners", () => {
  const received: InboxStreamEvent[] = [];
  const errors: unknown[][] = [];
  const originalError = console.error;
  console.error = (...args) => { errors.push(args); };
  const stopBroken = inboxEvents.subscribe(() => { throw new Error("closed stream"); });
  const stopHealthy = inboxEvents.subscribe((item) => received.push(item));
  try {
    inboxEvents.publish(event);
    assert.deepEqual(received, [event]);
    assert.equal(errors.length, 1);
  } finally {
    stopBroken();
    stopHealthy();
    console.error = originalError;
  }
});
