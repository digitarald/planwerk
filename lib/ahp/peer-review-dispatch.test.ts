import assert from "node:assert/strict";
import { test } from "node:test";

import type { AhpClient } from "@microsoft/agent-host-protocol/client";

import {
  createPeerChatWithCleanupOnFailure,
  dispatchPeerChatReviewWithClient,
  disposePeerChatAfterFailure,
  PeerChatCleanupRequiredError,
} from "./peer-review-dispatch.ts";

function clientFor(options: {
  dispatchError?: Error;
  pingError?: Error;
  disposalError?: Error;
  counts: { dispatch: number; ping: number; dispose: number };
}): Pick<AhpClient, "dispatch" | "ping" | "request"> {
  return {
    dispatch() {
      options.counts.dispatch++;
      if (options.dispatchError) throw options.dispatchError;
    },
    async ping() {
      options.counts.ping++;
      if (options.pingError) throw options.pingError;
    },
    async request(method: string) {
      assert.equal(method, "disposeChat");
      options.counts.dispose++;
      if (options.disposalError) throw options.disposalError;
      return undefined;
    },
  } as unknown as Pick<AhpClient, "dispatch" | "ping" | "request">;
}

test("dispatch confirmation and disposal failure preserves peer identity", async () => {
  const counts = { dispatch: 0, ping: 0, dispose: 0 };
  const cleanupError = new Error("dispose transport failed");

  await assert.rejects(
    dispatchPeerChatReviewWithClient(
      clientFor({
        counts,
        pingError: new Error("ping transport failed"),
        disposalError: cleanupError,
      }),
      "ahp-chat://review/1",
      "turn-1",
      "review",
    ),
    (error: unknown) => {
      assert(error instanceof PeerChatCleanupRequiredError);
      assert.equal(error.chatUri, "ahp-chat://review/1");
      assert.equal(error.turnId, "turn-1");
      assert.equal(error.cleanupError, cleanupError);
      assert.equal(error.dispatchAmbiguous, true);
      assert.equal(error.cleanupAttempts, 1);
      return true;
    },
  );
  assert.deepEqual(counts, { dispatch: 1, ping: 1, dispose: 1 });
});

test("synchronous dispatch and disposal failure remains retryable with cleanup identity", async () => {
  const counts = { dispatch: 0, ping: 0, dispose: 0 };
  const dispatchError = new Error("dispatch rejected");
  const cleanupError = new Error("dispose transport failed");

  await assert.rejects(
    dispatchPeerChatReviewWithClient(
      clientFor({
        counts,
        dispatchError,
        disposalError: cleanupError,
      }),
      "ahp-chat://review/sync",
      "turn-sync",
      "review",
    ),
    (error: unknown) => {
      assert(error instanceof PeerChatCleanupRequiredError);
      assert.equal(error.chatUri, "ahp-chat://review/sync");
      assert.equal(error.turnId, "turn-sync");
      assert.equal(error.cleanupError, cleanupError);
      assert.equal(error.dispatchAmbiguous, false);
      assert.equal(error.cause, dispatchError);
      return true;
    },
  );
  assert.deepEqual(counts, { dispatch: 1, ping: 0, dispose: 1 });
});

test("setup failure and disposal failure preserves cleanup identity", async () => {
  const cleanupError = new Error("setup disposal failed");
  const client = {
    async request(method: string) {
      assert.equal(method, "disposeChat");
      throw cleanupError;
    },
  } as unknown as Pick<AhpClient, "request">;
  const setupError = new Error("setup aborted after create");

  await assert.rejects(
    disposePeerChatAfterFailure(
      client,
      "ahp-chat://review/setup",
      setupError,
      { context: "Peer review setup failed" },
    ),
    (error: unknown) => {
      assert(error instanceof PeerChatCleanupRequiredError);
      assert.equal(error.chatUri, "ahp-chat://review/setup");
      assert.equal(error.turnId, undefined);
      assert.equal(error.cleanupError, cleanupError);
      assert.equal(error.dispatchAmbiguous, false);
      assert.equal(error.cause, setupError);
      return true;
    },
  );
});

test("confirmed disposal makes a post-dispatch ambiguity retryable", async () => {
  const counts = { dispatch: 0, ping: 0, dispose: 0 };
  const result = await dispatchPeerChatReviewWithClient(
    clientFor({
      counts,
      pingError: new Error("ping transport failed"),
    }),
    "ahp-chat://review/2",
    "turn-2",
    "review",
  );

  assert.equal(result.success, false);
  assert.equal(result.failureKind, "ambiguous-disposed");
  assert.match(result.reason ?? "", /disposal was confirmed/);
  assert.deepEqual(counts, { dispatch: 1, ping: 1, dispose: 1 });
});

test("pre-dispatch failure is distinct and never pings", async () => {
  const counts = { dispatch: 0, ping: 0, dispose: 0 };
  const result = await dispatchPeerChatReviewWithClient(
    clientFor({
      counts,
      dispatchError: new Error("dispatch rejected"),
    }),
    "ahp-chat://review/3",
    "turn-3",
    "review",
  );

  assert.equal(result.success, false);
  assert.equal(result.failureKind, "pre-dispatch");
  assert.match(result.reason ?? "", /dispatch rejected/);
  assert.deepEqual(counts, { dispatch: 1, ping: 0, dispose: 1 });
});

test("lost create acknowledgement disposes the already-known chat identity", async () => {
  const calls: Array<{ method: string; params: unknown }> = [];
  const responseLost = new Error("create response lost");
  const client = {
    async request(method: string, params: unknown) {
      calls.push({ method, params });
      if (method === "createChat") throw responseLost;
      assert.equal(method, "disposeChat");
    },
  } as unknown as Pick<AhpClient, "request">;
  const params = {
    channel: "ahp-session://owner",
    chat: "ahp-chat://deterministic/owner",
  };

  await assert.rejects(
    createPeerChatWithCleanupOnFailure(client, params),
    (error: unknown) => error === responseLost,
  );
  assert.deepEqual(calls, [
    { method: "createChat", params },
    {
      method: "disposeChat",
      params: { channel: "ahp-chat://deterministic/owner" },
    },
  ]);
});

test("lost create acknowledgement and failed cleanup preserves retry identity", async () => {
  const responseLost = new Error("create response lost");
  const cleanupError = new Error("dispose response lost");
  let requests = 0;
  const client = {
    async request(method: string) {
      requests++;
      if (method === "createChat") throw responseLost;
      throw cleanupError;
    },
  } as unknown as Pick<AhpClient, "request">;

  await assert.rejects(
    createPeerChatWithCleanupOnFailure(client, {
      channel: "ahp-session://owner",
      chat: "ahp-chat://cleanup-required/owner",
    }),
    (error: unknown) => {
      assert(error instanceof PeerChatCleanupRequiredError);
      assert.equal(error.chatUri, "ahp-chat://cleanup-required/owner");
      assert.equal(error.turnId, undefined);
      assert.equal(error.cleanupError, cleanupError);
      assert.equal(error.dispatchAmbiguous, false);
      assert.equal(error.cleanupAttempts, 1);
      assert.equal(error.cause, responseLost);
      return true;
    },
  );
  assert.equal(requests, 2);
});

test("confirmed cleanup keeps create acknowledgement failure retryable", async () => {
  let createAttempts = 0;
  let disposals = 0;
  const responseLost = new Error("create response lost");
  const client = {
    async request(method: string) {
      if (method === "createChat") {
        createAttempts++;
        if (createAttempts === 1) throw responseLost;
        return;
      }
      disposals++;
    },
  } as unknown as Pick<AhpClient, "request">;
  const params = {
    channel: "ahp-session://owner",
    chat: "ahp-chat://retry/owner",
  };

  await assert.rejects(
    createPeerChatWithCleanupOnFailure(client, params),
    (error: unknown) => error === responseLost,
  );
  await createPeerChatWithCleanupOnFailure(client, params);
  assert.equal(createAttempts, 2);
  assert.equal(disposals, 1);
});
