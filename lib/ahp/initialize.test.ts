import assert from "node:assert/strict";
import test from "node:test";

import { AhpErrorCodes, type InitializeParams, type InitializeResult } from "@microsoft/agent-host-protocol";
import { type AhpClient, RpcError } from "@microsoft/agent-host-protocol/client";

import { connectInitializedClient } from "./initialize.ts";
import { ProtocolCompatibilityError } from "./protocol.ts";

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

test("initializes once offering only AHP 1.0", async () => {
  const client = fakeClient(async () => initialized("1.0.0"));
  let creates = 0;
  const result = await connectInitializedClient(async () => {
    creates++;
    return client as unknown as AhpClient;
  }, { clientId: "test-client", initialSubscriptions: ["ahp-root:/"] });

  assert.equal(creates, 1);
  assert.equal(result.client, client);
  assert.deepEqual(client.initializeCalls[0], {
    clientId: "test-client",
    protocolVersions: ["1.0.0"],
    initialSubscriptions: ["ahp-root:/"],
  });
  assert.equal(client.shutdownCalls, 0);
});

for (const version of ["0.9.0", "1.1.0", "2.0.0"]) {
  test(`does not retry a host rejecting 1.0 and advertising ${version}`, async () => {
    const client = fakeClient(async () => {
      throw new RpcError(AhpErrorCodes.UnsupportedProtocolVersion, "unsupported", {
        supportedVersions: [version],
      });
    });
    let creates = 0;
    await assert.rejects(connectInitializedClient(async () => {
      creates++;
      return client as unknown as AhpClient;
    }), (error) => {
      assert.ok(error instanceof ProtocolCompatibilityError);
      assert.equal(error.failure, "no-overlap");
      assert.deepEqual(error.offeredVersions, ["1.0.0"]);
      assert.deepEqual(error.hostSupportedVersions, [version]);
      return true;
    });
    assert.equal(creates, 1);
    assert.equal(client.shutdownCalls, 1);
  });

  test(`rejects an unoffered selection of ${version} and closes the client`, async () => {
    const client = fakeClient(async () => initialized(version));
    await assert.rejects(
      connectInitializedClient(async () => client as unknown as AhpClient),
      (error) => error instanceof ProtocolCompatibilityError
        && error.failure === "selected-unoffered-version",
    );
    assert.equal(client.shutdownCalls, 1);
  });
}

test("preserves transport failures even when shutdown also fails", async () => {
  const error = new Error("connection lost");
  const client = fakeClient(async () => { throw error; });
  client.shutdown = async () => { throw new Error("shutdown failed"); };
  await assert.rejects(
    connectInitializedClient(async () => client as unknown as AhpClient),
    (thrown) => thrown === error,
  );
});
