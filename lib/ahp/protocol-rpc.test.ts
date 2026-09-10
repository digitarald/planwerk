import assert from "node:assert/strict";
import test from "node:test";

import { AhpErrorCodes } from "@microsoft/agent-host-protocol";
import { RpcError } from "@microsoft/agent-host-protocol/client";

import { readProtocolCompatibilityError } from "./protocol-rpc.ts";

test("reads structured unsupported-version errors", () => {
  const parsed = readProtocolCompatibilityError(new RpcError(
    AhpErrorCodes.UnsupportedProtocolVersion,
    "unsupported",
    { supportedVersions: ["0.10.0"] },
  ));

  assert.equal(parsed?.relation, "host-newer");
  assert.deepEqual(parsed?.hostSupportedVersions, ["0.10.0"]);
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

test("records the versions offered by a failed forward retry", () => {
  const parsed = readProtocolCompatibilityError(new RpcError(
    AhpErrorCodes.UnsupportedProtocolVersion,
    "unsupported",
    { supportedVersions: ["0.11.0"] },
  ), ["0.10.0", "0.9.0"]);

  assert.deepEqual(parsed?.offeredVersions, ["0.10.0", "0.9.0"]);
});
