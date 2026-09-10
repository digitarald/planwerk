import assert from "node:assert/strict";
import test from "node:test";

import { AhpErrorCodes, type InitializeParams, type InitializeResult } from "@microsoft/agent-host-protocol";
import { type AhpClient, RpcError } from "@microsoft/agent-host-protocol/client";

import {
  initializeAhpClientWithForwardRetry,
  shouldAllowForwardCompatibility,
} from "./initialize.ts";

interface FakeClient {
  initializeCalls: InitializeParams[];
  shutdownCalls: number;
  initialize(params: InitializeParams): Promise<InitializeResult>;
  shutdown(): Promise<void>;
}

function fakeClient(
  initialize: (params: InitializeParams) => Promise<InitializeResult>,
): FakeClient {
  return {
    initializeCalls: [],
    shutdownCalls: 0,
    async initialize(params) {
      this.initializeCalls.push(params);
      return initialize(params);
    },
    async shutdown() {
      this.shutdownCalls++;
    },
  };
}

function initialized(protocolVersion: string): InitializeResult {
  return {
    protocolVersion,
    serverSeq: 0,
    snapshots: [],
  } as unknown as InitializeResult;
}

test("initializes with the 0.9 baseline without reconnecting", async () => {
  const client = fakeClient(async () => initialized("0.9.0"));
  let creates = 0;

  const result = await initializeAhpClientWithForwardRetry(async () => {
    creates++;
    return client as unknown as AhpClient;
  }, {
    clientId: "test-client",
    allowForwardCompatibility: true,
  });

  assert.equal(creates, 1);
  assert.equal(result.client, client);
  assert.equal(result.usedForwardCompatibility, false);
  assert.deepEqual(client.initializeCalls[0].protocolVersions, ["0.9.0"]);
  assert.equal(client.shutdownCalls, 0);
});

test("reconnects once with strictly newer host-reported versions", async () => {
  const first = fakeClient(async () => {
    throw new RpcError(
      AhpErrorCodes.UnsupportedProtocolVersion,
      "unsupported",
      { supportedVersions: ["0.11.0", "0.10.0"] },
    );
  });
  const second = fakeClient(async () => initialized("0.11.0"));
  const clients = [first, second];

  const result = await initializeAhpClientWithForwardRetry(async () =>
    clients.shift() as unknown as AhpClient, {
    clientId: "test-client",
    allowForwardCompatibility: true,
  });

  assert.equal(result.client, second);
  assert.equal(result.usedForwardCompatibility, true);
  assert.equal(first.shutdownCalls, 1);
  assert.equal(second.shutdownCalls, 0);
  assert.deepEqual(second.initializeCalls[0].protocolVersions, [
    "0.11.0",
    "0.10.0",
    "0.9.0",
  ]);
  assert.equal(
    second.initializeCalls[0].clientId,
    first.initializeCalls[0].clientId,
  );
});

test("does not retry newer versions when forward compatibility is disabled", async () => {
  const error = new RpcError(
    AhpErrorCodes.UnsupportedProtocolVersion,
    "unsupported",
    { supportedVersions: ["0.10.0"] },
  );
  const client = fakeClient(async () => {
    throw error;
  });
  let creates = 0;

  await assert.rejects(
    initializeAhpClientWithForwardRetry(async () => {
      creates++;
      return client as unknown as AhpClient;
    }, {
      allowForwardCompatibility: false,
    }),
    (thrown) => thrown === error,
  );

  assert.equal(creates, 1);
  assert.equal(client.shutdownCalls, 1);
});

test("production disables forward compatibility even when requested", () => {
  assert.equal(shouldAllowForwardCompatibility(true, "production"), false);
  assert.equal(shouldAllowForwardCompatibility(true, "development"), true);
  assert.equal(shouldAllowForwardCompatibility(false, "development"), false);
});

test("closes the retry client and stops after a failed forward retry", async () => {
  const unsupported = (versions: string[]) => new RpcError(
    AhpErrorCodes.UnsupportedProtocolVersion,
    "unsupported",
    { supportedVersions: versions },
  );
  const first = fakeClient(async () => {
    throw unsupported(["0.10.0"]);
  });
  const second = fakeClient(async () => {
    throw unsupported(["0.11.0"]);
  });
  const clients = [first, second];

  await assert.rejects(
    initializeAhpClientWithForwardRetry(async () =>
      clients.shift() as unknown as AhpClient, {
      allowForwardCompatibility: true,
    }),
    (thrown) => {
      assert.equal((thrown as { failure?: unknown }).failure, "no-overlap");
      assert.deepEqual(
        (thrown as { offeredVersions?: unknown }).offeredVersions,
        ["0.10.0", "0.9.0"],
      );
      return true;
    },
  );

  assert.equal(clients.length, 0);
  assert.equal(first.shutdownCalls, 1);
  assert.equal(second.shutdownCalls, 1);
});
