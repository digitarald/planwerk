import assert from "node:assert/strict";
import test from "node:test";

import { chatTurnStarted } from "./actions.ts";
import {
  assertNegotiatedProtocolVersion,
  BASE_PROTOCOL_VERSION,
  classifyProtocolMismatch,
  OFFERED_PROTOCOL_VERSIONS,
  ProtocolCompatibilityError,
} from "./protocol.ts";

test("offers only the tested protocol by default", () => {
  assert.equal(BASE_PROTOCOL_VERSION, "1.0.0");
  assert.deepEqual(OFFERED_PROTOCOL_VERSIONS, ["1.0.0"]);
});

test("classifies exact host versions only when the direction is provable", () => {
  const client = ["1.0.0"];
  assert.equal(classifyProtocolMismatch(["0.8.0"], client), "host-older");
  assert.equal(classifyProtocolMismatch(["1.1.0", "2.0.0"], client), "host-newer");
  assert.equal(classifyProtocolMismatch(["0.8.0", "1.1.0"], client), "mixed");
});

test("keeps ranges, malformed values, missing data, and contradictory overlap neutral", () => {
  const client = ["1.0.0"];
  assert.equal(classifyProtocolMismatch([">=1.0.0 <2.0.0"], client), "unknown");
  assert.equal(classifyProtocolMismatch(["future"], client), "unknown");
  assert.equal(classifyProtocolMismatch([], client), "unknown");
  assert.equal(classifyProtocolMismatch(["1.0.0"], client), "unknown");
});

test("rejects a host-selected version that was not offered", () => {
  assert.doesNotThrow(() => assertNegotiatedProtocolVersion("1.0.0", ["1.0.0"]));
  assert.throws(
    () => assertNegotiatedProtocolVersion("1.1.0", ["1.0.0"]),
    (error) => {
      assert.ok(error instanceof ProtocolCompatibilityError);
      assert.equal(error.failure, "selected-unoffered-version");
      assert.equal(error.relation, "host-newer");
      return true;
    },
  );
});

test("turnStarted includes the protocol timestamp", () => {
  const startedAt = "2026-07-18T22:40:49.065Z";
  assert.deepEqual(chatTurnStarted("turn-1", "Hello", startedAt), {
    type: "chat/turnStarted",
    turnId: "turn-1",
    message: { text: "Hello", origin: { kind: "user" } },
    startedAt,
  });
});
