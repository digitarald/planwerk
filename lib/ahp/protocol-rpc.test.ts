import assert from "node:assert/strict";
import test from "node:test";

import { AhpErrorCodes } from "@microsoft/agent-host-protocol";
import { RpcError } from "@microsoft/agent-host-protocol/client";

import { readProtocolCompatibilityError } from "./protocol-rpc.ts";

test("reads structured unsupported-version errors", () => {
  const parsed = readProtocolCompatibilityError(new RpcError(
    AhpErrorCodes.UnsupportedProtocolVersion,
    "unsupported",
    { supportedVersions: ["1.1.0"] },
  ));

  assert.equal(parsed?.relation, "host-newer");
  assert.deepEqual(parsed?.hostSupportedVersions, ["1.1.0"]);
});

test("handles malformed unsupported-version data without throwing", () => {
  const parsed = readProtocolCompatibilityError(new RpcError(
    AhpErrorCodes.UnsupportedProtocolVersion,
    "unsupported",
    { supportedVersions: ["0.8.0", 8, null] },
  ));

  assert.equal(parsed?.relation, "unknown");
  assert.deepEqual(parsed?.hostSupportedVersions, ["0.8.0"]);
  assert.equal(
    readProtocolCompatibilityError(new RpcError(AhpErrorCodes.NotFound, "missing")),
    undefined,
  );
});

test("records the explicitly offered versions", () => {
  const parsed = readProtocolCompatibilityError(new RpcError(
    AhpErrorCodes.UnsupportedProtocolVersion,
    "unsupported",
    { supportedVersions: ["2.0.0"] },
  ), ["1.1.0", "1.0.0"]);

  assert.deepEqual(parsed?.offeredVersions, ["1.1.0", "1.0.0"]);
});
