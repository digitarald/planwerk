import assert from "node:assert/strict";
import test from "node:test";

import { chatTurnStarted } from "./actions.ts";
import {
  assertNegotiatedProtocolVersion,
  BASE_PROTOCOL_VERSION,
  classifyProtocolMismatch,
  forwardRetryProtocolVersions,
  OFFERED_PROTOCOL_VERSIONS,
  ProtocolCompatibilityError,
} from "./protocol.ts";

test("offers only the tested protocol by default", () => {
  assert.equal(BASE_PROTOCOL_VERSION, "0.9.0");
  assert.deepEqual(OFFERED_PROTOCOL_VERSIONS, ["0.9.0"]);
});

test("classifies exact host versions only when the direction is provable", () => {
  const client = ["0.9.0"];
  assert.equal(classifyProtocolMismatch(["0.8.0"], client), "host-older");
  assert.equal(classifyProtocolMismatch(["0.10.0", "0.11.0"], client), "host-newer");
  assert.equal(classifyProtocolMismatch(["0.8.0", "0.10.0"], client), "mixed");
});

test("keeps ranges, malformed values, missing data, and contradictory overlap neutral", () => {
  const client = ["0.9.0"];
  assert.equal(classifyProtocolMismatch([">=0.10.0 <1.0.0"], client), "unknown");
  assert.equal(classifyProtocolMismatch(["future"], client), "unknown");
  assert.equal(classifyProtocolMismatch([], client), "unknown");
  assert.equal(classifyProtocolMismatch(["0.9.0"], client), "unknown");
});

test("rejects a host-selected version that was not offered", () => {
  assert.doesNotThrow(() => assertNegotiatedProtocolVersion("0.9.0", ["0.9.0"]));
  assert.throws(
    () => assertNegotiatedProtocolVersion("0.10.0", ["0.9.0"]),
    (error) => {
      assert.ok(error instanceof ProtocolCompatibilityError);
      assert.equal(error.failure, "selected-unoffered-version");
      assert.equal(error.relation, "host-newer");
      return true;
    },
  );
});

test("retries only strictly newer exact versions outside production", () => {
  const newer = new ProtocolCompatibilityError({
    failure: "no-overlap",
    hostSupportedVersions: ["0.10.0", "0.11.0", "0.10.0"],
  });
  assert.deepEqual(
    forwardRetryProtocolVersions(newer, true),
    ["0.11.0", "0.10.0", "0.9.0"],
  );
  assert.equal(forwardRetryProtocolVersions(newer, false), undefined);

  const older = new ProtocolCompatibilityError({
    failure: "no-overlap",
    hostSupportedVersions: ["0.8.0"],
  });
  assert.equal(forwardRetryProtocolVersions(older, true), undefined);

  const mixed = new ProtocolCompatibilityError({
    failure: "no-overlap",
    hostSupportedVersions: ["0.8.0", "0.10.0"],
  });
  assert.equal(forwardRetryProtocolVersions(mixed, true), undefined);
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
