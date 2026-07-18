import assert from "node:assert/strict";
import test from "node:test";

import {
  isPlanChangeConfirmed,
  isPlanChangeDelivered,
  type PlanChangeResult,
} from "./plan-change-result.ts";

test("a pinged critique is delivered even when host removal was not observed before the deadline", () => {
  const result: PlanChangeResult = {
    outcome: "delivered-unconfirmed",
    followUpRequestId: "follow-up",
  };

  assert.equal(isPlanChangeDelivered(result), true);
  assert.equal(isPlanChangeConfirmed(result), false);
});

test("only confirmed critiques claim host consumption", () => {
  const result: PlanChangeResult = {
    outcome: "confirmed",
    followUpRequestId: "follow-up",
  };

  assert.equal(isPlanChangeDelivered(result), true);
  assert.equal(isPlanChangeConfirmed(result), true);
});

test("stale and undelivered critiques remain failures", () => {
  assert.equal(isPlanChangeDelivered({ outcome: "stale" }), false);
  assert.equal(isPlanChangeDelivered({ outcome: "undelivered" }), false);
});
