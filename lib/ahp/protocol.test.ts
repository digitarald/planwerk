import assert from "node:assert/strict";
import test from "node:test";

import { chatTurnStarted } from "./actions.ts";
import {
  assertNegotiatedProtocolVersion,
  buildOfferedProtocolVersions,
  classifyProtocolMismatch,
  OFFERED_PROTOCOL_VERSIONS,
  ProtocolCompatibilityError,
} from "./protocol.ts";

test("offers the newest VS Code AHP compatibility protocol before SDK versions", () => {
  assert.deepEqual(OFFERED_PROTOCOL_VERSIONS.slice(0, 2), ["0.7.0", "0.6.0"]);
  assert.equal(new Set(OFFERED_PROTOCOL_VERSIONS).size, OFFERED_PROTOCOL_VERSIONS.length);
});

test("does not duplicate compatibility offers when a future SDK supports them", () => {
  assert.deepEqual(
    buildOfferedProtocolVersions(["0.7.0", "0.6.0", "0.5.1"]),
    ["0.7.0", "0.6.0", "0.5.1"],
  );
});

test("orders valid exact protocol offers from newest to oldest", () => {
  assert.deepEqual(buildOfferedProtocolVersions(["0.5.1", "0.8.0", "0.4.9"]), [
    "0.8.0",
    "0.7.0",
    "0.6.0",
    "0.5.1",
    "0.4.9",
  ]);
  assert.throws(
    () => buildOfferedProtocolVersions(["^0.8.0"]),
    /cannot advertise invalid AHP protocol version/,
  );
});

test("classifies exact host versions only when the direction is provable", () => {
  const client = ["0.7.0", "0.6.0", "0.5.1"];
  assert.equal(classifyProtocolMismatch(["0.4.0"], client), "host-older");
  assert.equal(classifyProtocolMismatch(["0.8.0", "0.9.0"], client), "host-newer");
  assert.equal(classifyProtocolMismatch(["0.4.0", "0.8.0"], client), "mixed");
  assert.equal(classifyProtocolMismatch(["0.5.2"], client), "mixed");
});

test("keeps ranges, malformed values, missing data, and contradictory overlap neutral", () => {
  const client = ["0.7.0", "0.6.0", "0.5.1"];
  assert.equal(classifyProtocolMismatch([">=0.8.0 <1.0.0"], client), "unknown");
  assert.equal(classifyProtocolMismatch(["future"], client), "unknown");
  assert.equal(classifyProtocolMismatch([], client), "unknown");
  assert.equal(classifyProtocolMismatch(["0.7.0"], client), "unknown");
});

test("rejects a host-selected version that was not offered", () => {
  assert.doesNotThrow(() => assertNegotiatedProtocolVersion("0.7.0", ["0.7.0", "0.6.0"]));
  assert.throws(
    () => assertNegotiatedProtocolVersion("0.8.0", ["0.7.0", "0.6.0"]),
    (error) => {
      assert.ok(error instanceof ProtocolCompatibilityError);
      assert.equal(error.failure, "selected-unoffered-version");
      assert.equal(error.relation, "host-newer");
      return true;
    },
  );
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
