import assert from "node:assert/strict";
import test from "node:test";

import { routeInboxClientAction } from "./client-action-routing.ts";

test("routes WIP inspection to the board", () => {
  assert.deepEqual(
    routeInboxClientAction("wip-violation", "inspect", false),
    { type: "board" },
  );
});

test("routes inbox-state actions to durable mutations", () => {
  assert.deepEqual(
    routeInboxClientAction("session-idle", "mark-read", true),
    { type: "mutation", action: "read" },
  );
  assert.deepEqual(
    routeInboxClientAction("session-idle", "resolve", true),
    { type: "mutation", action: "resolve" },
  );
});

test("routes contextual actions to an available card", () => {
  for (const action of [
    "review",
    "reply",
    "approve",
    "inspect",
    "open-session",
  ] as const) {
    assert.deepEqual(
      routeInboxClientAction("pending-input", action, true),
      { type: "card" },
    );
  }
});

test("reports contextual actions whose source card is unavailable", () => {
  assert.deepEqual(
    routeInboxClientAction("pending-input", "reply", false),
    { type: "unavailable" },
  );
});
