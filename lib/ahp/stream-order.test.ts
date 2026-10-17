import assert from "node:assert/strict";
import test from "node:test";
import { StreamOrder } from "./stream-order.ts";

test("snapshots admit only ordered events and discard duplicates/retired epochs", () => {
  const order = new StreamOrder();
  assert.equal(order.accept({ type: "cardChanged", epoch: "a", sequence: 1 }), "resync");
  assert.equal(order.accept({ type: "init", epoch: "a", sequence: 1 }), "accept");
  assert.equal(order.accept({ type: "cardRemoved", epoch: "a", sequence: 2 }), "accept");
  assert.equal(order.accept({ type: "cardChanged", epoch: "a", sequence: 1 }), "stale");
  assert.equal(order.accept({ type: "init", epoch: "b", sequence: 1 }), "accept");
  assert.equal(order.accept({ type: "init", epoch: "a", sequence: 1 }), "stale");
  assert.equal(order.accept({ type: "cardChanged", epoch: "b", sequence: 3 }), "resync");
  assert.equal(order.accept({ type: "cardChanged" }), "resync");
});
