import assert from "node:assert/strict";
import test from "node:test";
import type { AhpClient, SubscriptionEvent } from "@microsoft/agent-host-protocol/client";
import { Subscription } from "@microsoft/agent-host-protocol/client";
import type { ChangesetState, Snapshot } from "@microsoft/agent-host-protocol";

import {
  readReadyChangesetState,
  waitForReadyChangesetState,
} from "./changeset-readiness.ts";

const URI = "ahp-changeset:/session-1";
const COMPUTING = "computing" as ChangesetState["status"];
const READY = "ready" as ChangesetState["status"];

function snapshot(status: ChangesetState["status"], fileId = "file-a"): Snapshot {
  return {
    resource: URI,
    fromSeq: 1,
    state: {
      status,
      files: status === "ready"
        ? [{
            id: fileId,
            edit: {
              after: {
                uri: `file:///${fileId}`,
                content: { uri: `file:///${fileId}` },
              },
            },
          }]
        : [],
    },
  };
}

function statusEvent(status: "ready" | "error"): SubscriptionEvent {
  return {
    type: "action",
    params: {
      channel: URI,
      serverSeq: 2,
      origin: undefined,
      action: {
        type: "changeset/statusChanged",
        status,
      },
    },
  } as unknown as SubscriptionEvent;
}

function contentEvent(fileId: string): SubscriptionEvent {
  return {
    type: "action",
    params: {
      channel: URI,
      serverSeq: 2,
      origin: undefined,
      action: {
        type: "changeset/contentChanged",
        files: [{
          id: fileId,
          edit: {
            after: {
              uri: `file:///${fileId}`,
              content: { uri: `file:///${fileId}` },
            },
          },
        }],
      },
    },
  } as unknown as SubscriptionEvent;
}

function subscription(
  events: SubscriptionEvent[],
  onClose: () => void,
): Subscription {
  let index = 0;
  let pending:
    | ((result: IteratorResult<SubscriptionEvent>) => void)
    | undefined;

  const iterator: AsyncIterableIterator<SubscriptionEvent> = {
    async next() {
      if (index < events.length) {
        return { value: events[index++], done: false };
      }
      return new Promise<IteratorResult<SubscriptionEvent>>((resolve) => {
        pending = resolve;
      });
    },
    async return() {
      onClose();
      pending?.({ value: undefined, done: true });
      return { value: undefined, done: true };
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  };

  return new Subscription(URI, iterator);
}

function fakeClient(
  states: Snapshot[],
  events: SubscriptionEvent[][],
): {
  client: Pick<AhpClient, "subscribe" | "unsubscribe">;
  calls: { subscribes: number; unsubscribes: number; closes: number };
} {
  const calls = { subscribes: 0, unsubscribes: 0, closes: 0 };

  const client: Pick<AhpClient, "subscribe" | "unsubscribe"> = {
    async subscribe() {
      const index = calls.subscribes++;
      return {
        result: { snapshot: states[index] },
        subscription: subscription(events[index] ?? [], () => {
          calls.closes++;
        }),
      };
    },
    async unsubscribe() {
      calls.unsubscribes++;
    },
  };

  return { client, calls };
}

test("returns an immediately ready changeset and releases its subscription", async () => {
  const { client, calls } = fakeClient([snapshot(READY)], [[]]);

  const state = await readReadyChangesetState(client, URI, 20);

  assert.equal(state?.status, "ready");
  assert.equal(state?.files[0]?.id, "file-a");
  assert.deepEqual(calls, { subscribes: 1, unsubscribes: 1, closes: 1 });
});

test("reduces streamed content before accepting a ready changeset", async () => {
  const { client, calls } = fakeClient(
    [snapshot(COMPUTING)],
    [[contentEvent("file-b"), statusEvent("ready")]],
  );

  const state = await readReadyChangesetState(client, URI, 20);

  assert.equal(state?.files[0]?.id, "file-b");
  assert.deepEqual(calls, { subscribes: 1, unsubscribes: 1, closes: 1 });
});

test("keeps an errored changeset unknown without re-reading", async () => {
  const { client, calls } = fakeClient(
    [snapshot(COMPUTING)],
    [[statusEvent("error")]],
  );

  assert.equal(await readReadyChangesetState(client, URI, 20), undefined);
  assert.deepEqual(calls, { subscribes: 1, unsubscribes: 1, closes: 1 });
});

test("keeps a timed-out changeset unknown and closes the pending iterator", async () => {
  const { client, calls } = fakeClient([snapshot(COMPUTING)], [[]]);

  assert.equal(await readReadyChangesetState(client, URI, 5), undefined);
  assert.deepEqual(calls, { subscribes: 1, unsubscribes: 1, closes: 1 });
});

test("reduces incremental actions while waiting for terminal status", async () => {
  const initial = snapshot(READY).state as ChangesetState;
  initial.status = COMPUTING;
  const removed = {
    type: "action",
    params: {
      channel: URI,
      serverSeq: 2,
      origin: undefined,
      action: { type: "changeset/fileRemoved", fileId: "file-a" },
    },
  } as unknown as SubscriptionEvent;
  const stream = subscription(
    [removed, statusEvent("ready")],
    () => {},
  );

  const state = await waitForReadyChangesetState(initial, stream, 20);
  assert.equal(state?.status, "ready");
  assert.deepEqual(state?.files, []);
  await stream.close();
});

for (const outcome of ["ready", "error", "timeout"] as const) {
  test(`waits for a recomputing changeset: ${outcome}`, async () => {
    const refreshing = snapshot(READY);
    (refreshing.state as ChangesetState).status = "recomputing" as ChangesetState["status"];
    const events = outcome === "timeout" ? [] : [contentEvent("refreshed"), statusEvent(outcome)];
    const { client, calls } = fakeClient([refreshing], [events]);
    const state = await readReadyChangesetState(client, URI, 10);
    if (outcome === "ready") {
      assert.equal(state?.status, "ready");
      assert.equal(state?.files[0]?.id, "refreshed");
    } else {
      assert.equal(state, undefined);
    }
    assert.deepEqual(calls, { subscribes: 1, unsubscribes: 1, closes: 1 });
  });
}
