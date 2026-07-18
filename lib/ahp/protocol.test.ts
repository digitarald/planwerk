import assert from "node:assert/strict";
import test from "node:test";

import { chatTurnStarted } from "./actions.ts";
import { buildOfferedProtocolVersions, OFFERED_PROTOCOL_VERSIONS } from "./protocol.ts";

test("offers the VS Code AHP 0.6 protocol before SDK versions", () => {
  assert.equal(OFFERED_PROTOCOL_VERSIONS[0], "0.6.0");
  assert.equal(new Set(OFFERED_PROTOCOL_VERSIONS).size, OFFERED_PROTOCOL_VERSIONS.length);
});

test("does not duplicate the compatibility offer when a future SDK supports AHP 0.6", () => {
  assert.deepEqual(buildOfferedProtocolVersions(["0.6.0", "0.5.1"]), ["0.6.0", "0.5.1"]);
});

test("turnStarted includes the AHP 0.6 startedAt compatibility field", () => {
  const startedAt = "2026-07-18T22:40:49.065Z";
  assert.deepEqual(chatTurnStarted("turn-1", "Hello", startedAt), {
    type: "chat/turnStarted",
    turnId: "turn-1",
    message: { text: "Hello", origin: { kind: "user" } },
    startedAt,
  });
});
