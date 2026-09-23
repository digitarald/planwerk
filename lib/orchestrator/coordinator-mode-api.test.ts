import assert from "node:assert/strict";
import { test } from "node:test";

import Database from "better-sqlite3";

import { ensureCoordinatorModeSchema } from "../db/coordinator-mode-schema.ts";
import { CoordinatorModeStore } from "../db/coordinator-mode-store.ts";
import {
  handleCoordinatorModeGet,
  handleCoordinatorModePost,
} from "./coordinator-mode-api.ts";

const baseUrl = "http://127.0.0.1:3000";

function createStore() {
  const db = new Database(":memory:");
  ensureCoordinatorModeSchema(db);
  return { db, store: new CoordinatorModeStore(db) };
}

function postRequest(body: unknown, origin = baseUrl): Request {
  return new Request(`${baseUrl}/api/orchestrator/mode`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      host: "127.0.0.1:3000",
      origin,
      "sec-fetch-site": "same-origin",
    },
    body: JSON.stringify(body),
  });
}

test("mode GET accepts repeated and comma-separated cardIds", async () => {
  const { db, store } = createStore();
  store.setBoardDefault("verify");
  store.setSessionOverride("host-a", "card-1", "coordinate");

  const response = handleCoordinatorModeGet(
    new Request(
      `${baseUrl}/api/orchestrator/mode?hostUrl=host-a&cardIds=card-1,card-2&cardIds=card-3`,
    ),
    store,
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    boardDefault: {
      mode: "verify",
      updatedAt: store.getBoardDefault().updatedAt,
    },
    overrides: [store.getSessionOverride("host-a", "card-1")],
    effectiveModes: [
      store.getEffectiveMode("host-a", "card-1"),
      store.getEffectiveMode("host-a", "card-2"),
      store.getEffectiveMode("host-a", "card-3"),
    ],
  });
  db.close();
});

test("mode POST persists board and session state, including removal", async () => {
  const { db, store } = createStore();
  const boardResponse = await handleCoordinatorModePost(
    postRequest({ scope: "board", mode: "verify" }),
    store,
  );
  assert.equal(boardResponse.status, 200);
  assert.equal(
    ((await boardResponse.json()) as {
      boardDefault: { mode: string };
    }).boardDefault.mode,
    "verify",
  );

  const sessionResponse = await handleCoordinatorModePost(
    postRequest({
      scope: "session",
      hostUrl: " host-a ",
      cardId: " card-1 ",
      mode: "coordinate",
    }),
    store,
  );
  assert.equal(sessionResponse.status, 200);
  const sessionState = await sessionResponse.json() as {
    overrides: Array<{ hostUrl: string; cardId: string; mode: string }>;
    effectiveModes: Array<{ mode: string; source: string }>;
  };
  assert.deepEqual(sessionState.overrides.map(({ hostUrl, cardId, mode }) => ({
    hostUrl,
    cardId,
    mode,
  })), [{ hostUrl: "host-a", cardId: "card-1", mode: "coordinate" }]);
  assert.equal(sessionState.effectiveModes[0]?.source, "session");

  const removalResponse = await handleCoordinatorModePost(
    postRequest({
      scope: "session",
      hostUrl: "host-a",
      cardId: "card-1",
      mode: null,
    }),
    store,
  );
  const removalState = await removalResponse.json() as {
    overrides: unknown[];
    effectiveModes: Array<{ mode: string; source: string }>;
  };
  assert.deepEqual(removalState.overrides, []);
  assert.deepEqual(removalState.effectiveModes.map(({ mode, source }) => ({
    mode,
    source,
  })), [{ mode: "verify", source: "board" }]);
  assert.equal(store.listAudit().length, 3);
  db.close();
});

test("mode POST validates local requests and payload variants", async () => {
  const { db, store } = createStore();
  const crossOrigin = await handleCoordinatorModePost(
    postRequest({ scope: "board", mode: "verify" }, "http://example.com"),
    store,
  );
  assert.equal(crossOrigin.status, 403);

  for (const body of [
    { scope: "board", mode: "active" },
    { scope: "board", mode: null },
    { scope: "session", hostUrl: "", cardId: "card-1", mode: "observe" },
    { scope: "session", hostUrl: "host-a", cardId: " ", mode: "verify" },
    {
      scope: "session",
      hostUrl: "host-a",
      cardId: "card-1",
      mode: "active",
    },
  ]) {
    const response = await handleCoordinatorModePost(postRequest(body), store);
    assert.equal(response.status, 400, JSON.stringify(body));
  }
  assert.equal(store.getBoardDefault().mode, "observe");
  assert.deepEqual(store.listAudit(), []);
  db.close();
});
