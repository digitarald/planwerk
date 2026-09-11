import assert from "node:assert/strict";
import { test } from "node:test";

import {
  HostStreamRegistry,
  type HostStreamSubscriber,
} from "./host-stream-registry.ts";

interface Resource {
  hostUrl: string;
  disposed: boolean;
}

function subscriber(
  id: number,
  received: string[],
  workspaceScope: Set<string> | null = null,
): HostStreamSubscriber<string> {
  return {
    id,
    workspaceScope,
    send: (event) => received.push(event),
    close: () => received.push("closed"),
  };
}

test("partitions cards and broadcasts by originating host", () => {
  const registry = new HostStreamRegistry<string, string, Resource>(
    (hostUrl) => ({ hostUrl, disposed: false }),
    (resource) => {
      resource.disposed = true;
    },
  );
  const hostAEvents: string[] = [];
  const hostBEvents: string[] = [];

  const hostA = registry.subscribe(
    "ws://127.0.0.1:8101",
    subscriber(1, hostAEvents, new Set(["/workspace/a"])),
  ).partition;
  const hostB = registry.subscribe(
    "ws://127.0.0.1:8102",
    subscriber(2, hostBEvents, new Set(["/workspace/b"])),
  ).partition;
  hostA.cards = ["card-a"];
  hostB.cards = ["card-b"];

  registry.broadcast(hostA.hostUrl, "action-a");
  assert.deepEqual(hostAEvents, ["action-a"]);
  assert.deepEqual(hostBEvents, []);
  assert.deepEqual(registry.get(hostA.hostUrl)?.cards, ["card-a"]);
  assert.deepEqual(registry.get(hostB.hostUrl)?.cards, ["card-b"]);
});

test("disconnecting the first subscriber preserves the host and survivor", () => {
  const disposed: string[] = [];
  const registry = new HostStreamRegistry<string, string, Resource>(
    (hostUrl) => ({ hostUrl, disposed: false }),
    (resource) => {
      resource.disposed = true;
      disposed.push(resource.hostUrl);
    },
  );
  const firstEvents: string[] = [];
  const survivorEvents: string[] = [];
  const otherHostEvents: string[] = [];
  const host = "ws://127.0.0.1:8201";
  const otherHost = "ws://127.0.0.1:8202";

  registry.subscribe(host, subscriber(1, firstEvents));
  registry.subscribe(host, subscriber(2, survivorEvents));
  registry.subscribe(otherHost, subscriber(3, otherHostEvents));

  const firstRemoval = registry.unsubscribe(host, 1);
  assert.equal(firstRemoval.hostRemoved, false);
  assert.equal(firstRemoval.activeHostCount, 2);
  assert.deepEqual(disposed, []);

  registry.broadcast(host, "still-live");
  assert.deepEqual(firstEvents, []);
  assert.deepEqual(survivorEvents, ["still-live"]);
  assert.deepEqual(otherHostEvents, []);

  const finalRemoval = registry.unsubscribe(host, 2);
  assert.equal(finalRemoval.hostRemoved, true);
  assert.equal(finalRemoval.activeHostCount, 1);
  assert.deepEqual(disposed, [host]);

  registry.broadcast(otherHost, "other-still-live");
  assert.deepEqual(otherHostEvents, ["other-still-live"]);
});

test("later subscribers receive initialization for an empty board", () => {
  const registry = new HostStreamRegistry<string, string, Resource>(
    (hostUrl) => ({ hostUrl, disposed: false }),
    (resource) => {
      resource.disposed = true;
    },
  );
  const host = "ws://127.0.0.1:8301";
  const firstEvents: string[] = [];
  const laterEvents: string[] = [];
  const first = registry.subscribe(host, subscriber(1, firstEvents)).partition;
  first.cards = [];
  first.initialized = true;

  const later = subscriber(2, laterEvents);
  const existing = registry.subscribe(host, later).partition;
  assert.equal(existing, first);
  assert.equal(
    registry.replayInitialization(
      existing,
      later,
      (cards) => `init:${JSON.stringify(cards)}`,
    ),
    true,
  );
  assert.deepEqual(laterEvents, ["init:[]"]);
});

test("delayed projection cannot mutate or broadcast to a replacement partition", async () => {
  const registry = new HostStreamRegistry<string, string, Resource>(
    (hostUrl) => ({ hostUrl, disposed: false }),
    (resource) => {
      resource.disposed = true;
    },
  );
  const host = "ws://127.0.0.1:8401";
  const retiredEvents: string[] = [];
  const replacementEvents: string[] = [];
  const projectionReady = deferredProjection();
  const retired = registry.subscribe(
    host,
    subscriber(1, retiredEvents),
  ).partition;

  const continuation = projectionReady.promise.then((projected) => {
    const applied = registry.applyIfCurrent(retired, (current) => {
      current.cards = [projected];
    });
    const broadcast = registry.broadcastPartition(retired, projected);
    return { applied, broadcast };
  });

  registry.unsubscribe(host, 1);
  const replacement = registry.subscribe(
    host,
    subscriber(2, replacementEvents),
  ).partition;
  assert.notEqual(replacement.generation, retired.generation);
  replacement.cards = ["replacement"];

  projectionReady.resolve("retired-projection");
  assert.deepEqual(await continuation, {
    applied: false,
    broadcast: false,
  });
  registry.closeHost(host, retired);
  assert.deepEqual(replacement.cards, ["replacement"]);
  assert.deepEqual(replacementEvents, []);
  assert.equal(registry.get(host), replacement);
});

function deferredProjection(): {
  promise: Promise<string>;
  resolve(value: string): void;
} {
  let resolve!: (value: string) => void;
  const promise = new Promise<string>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
