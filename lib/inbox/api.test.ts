import assert from "node:assert/strict";
import test from "node:test";

import {
  parseInboxActionBody,
  parseInboxHostUrl,
  parseInboxListQuery,
} from "./api.ts";

test("inbox list query defaults to all items and validates filters", () => {
  assert.deepEqual(parseInboxListQuery(new URLSearchParams()), {
    ok: true,
    value: {
      workflowState: "all",
      readState: "all",
      kind: undefined,
      cardId: undefined,
      hostUrl: undefined,
      limit: 100,
    },
  });
  assert.deepEqual(
    parseInboxListQuery(new URLSearchParams("state=all&read=unread&limit=20")),
    {
      ok: true,
      value: {
        workflowState: "all",
        readState: "unread",
        kind: undefined,
        cardId: undefined,
        hostUrl: undefined,
        limit: 20,
      },
    },
  );
  assert.equal(
    parseInboxListQuery(
      new URLSearchParams("host=ws%3A%2F%2F127.0.0.1%3A9000"),
    ).ok,
    true,
  );
  assert.equal(
    parseInboxListQuery(new URLSearchParams("host=https%3A%2F%2Fexample.com"))
      .ok,
    false,
  );
  assert.deepEqual(
    parseInboxListQuery(new URLSearchParams("state=unknown")),
    {
      ok: false,
      error: "state must be open, resolved, dismissed, or all",
    },
  );
  assert.deepEqual(
    parseInboxListQuery(new URLSearchParams("limit=501")),
    {
      ok: false,
      error: "limit must be an integer from 1 to 500",
    },
  );
});

test("inbox host parsing accepts supported AHP endpoints", () => {
  assert.deepEqual(parseInboxHostUrl(null), {
    ok: true,
    value: undefined,
  });
  assert.deepEqual(parseInboxHostUrl("vscode-local://desktop"), {
    ok: true,
    value: "vscode-local://desktop",
  });
  assert.equal(parseInboxHostUrl("wss://agent.example.test").ok, true);
  assert.equal(parseInboxHostUrl("https://agent.example.test").ok, false);
});

test("inbox action parsing only accepts local organization actions", () => {
  assert.deepEqual(
    parseInboxActionBody({ action: "read" }),
    {
      ok: true,
      value: { action: "read", snoozedUntil: null },
    },
  );
  assert.equal(parseInboxActionBody({ action: "execute" }).ok, false);
  assert.equal(parseInboxActionBody({ action: "resolve", note: "extra" }).ok, false);
  assert.equal(parseInboxActionBody(null).ok, false);
  assert.equal(parseInboxActionBody({ action: "snooze" }).ok, false);
  assert.equal(
    parseInboxActionBody({
      action: "snooze",
      snoozedUntil: Date.now() + 60_000,
    }).ok,
    true,
  );
});
