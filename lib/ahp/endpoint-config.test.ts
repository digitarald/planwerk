import assert from "node:assert/strict";
import test from "node:test";

import {
  LOCAL_DESKTOP_HOST,
  migratePersistedAhpEndpoint,
} from "./endpoint-config.ts";

test("migrates legacy loopback editor endpoints to desktop discovery", () => {
  assert.equal(
    migratePersistedAhpEndpoint(
      "ws://localhost:54616?tkn=d2aac8b3-5d35-4cc1-89e9-eeac0616c3d0",
    ),
    LOCAL_DESKTOP_HOST,
  );
  assert.equal(
    migratePersistedAhpEndpoint("ws://127.0.0.1:54616/?tkn=secret"),
    LOCAL_DESKTOP_HOST,
  );
  assert.equal(
    migratePersistedAhpEndpoint("ws://[::1]:54616?tkn=secret"),
    LOCAL_DESKTOP_HOST,
  );
});

test("preserves explicit hosts and rejects invalid persisted values", () => {
  assert.equal(
    migratePersistedAhpEndpoint("ws://127.0.0.1:8082"),
    "ws://127.0.0.1:8082",
  );
  assert.equal(
    migratePersistedAhpEndpoint("wss://agent.example.com?tkn=secret"),
    "wss://agent.example.com?tkn=secret",
  );
  assert.equal(
    migratePersistedAhpEndpoint(LOCAL_DESKTOP_HOST),
    LOCAL_DESKTOP_HOST,
  );
  assert.equal(migratePersistedAhpEndpoint("https://example.com"), null);
  assert.equal(migratePersistedAhpEndpoint(undefined), null);
});
