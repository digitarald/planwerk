import assert from "node:assert/strict";
import test from "node:test";
import { inboxSourceFreshness, INBOX_SOURCE_STALE_MS } from "./freshness.ts";

test("source freshness distinguishes unknown, disconnected and the exact stale threshold", () => {
  const observed = Date.parse("2026-09-22T00:00:00Z");
  assert.equal(inboxSourceFreshness(undefined, true, observed), "unverified");
  assert.equal(inboxSourceFreshness(NaN, true, observed), "unverified");
  assert.equal(inboxSourceFreshness(observed, false, observed), "disconnected");
  assert.equal(inboxSourceFreshness(observed, true, observed + INBOX_SOURCE_STALE_MS), "current");
  assert.equal(inboxSourceFreshness(observed, true, observed + INBOX_SOURCE_STALE_MS + 1), "stale");
});
