import { test } from "node:test";
import assert from "node:assert/strict";

import {
  normalizeChangesetRef,
  isPlanChangesetRef,
  changesetCodeRef,
  isGateRunStale,
  type GateRunView,
} from "../types.ts";

function passedRun(changesetRef?: string): GateRunView {
  return {
    id: 1,
    cardId: "copilotcli:/x",
    fromPhase: "plan",
    toPhase: "build",
    gateType: "review",
    gateName: "plan-review",
    status: "passed",
    startedAt: "2026-07-08T00:00:00Z",
    completedAt: "2026-07-08T00:01:00Z",
    changesetRef,
  };
}

test("normalizeChangesetRef: empty/absent → empty string", () => {
  assert.equal(normalizeChangesetRef(undefined), "");
  assert.equal(normalizeChangesetRef(""), "");
});

test("normalizeChangesetRef: code ref drops the modifiedAt suffix", () => {
  assert.equal(normalizeChangesetRef("25:752:179:1783489307605"), "25:752:179");
  assert.equal(normalizeChangesetRef("25:752:179"), "25:752:179");
});

test("normalizeChangesetRef: plan ref is opaque (compared whole)", () => {
  assert.equal(normalizeChangesetRef("plan:abc123def456"), "plan:abc123def456");
  assert.ok(isPlanChangesetRef("plan:abc123def456"));
  assert.ok(!isPlanChangesetRef("25:752:179"));
});

test("changesetCodeRef: joins the three diff dimensions", () => {
  assert.equal(
    changesetCodeRef({ filesChanged: 25, additions: 752, deletions: 179 }),
    "25:752:179"
  );
});

test("isGateRunStale: no ref recorded → never stale", () => {
  assert.equal(isGateRunStale(passedRun(undefined), { filesChanged: 5, additions: 10, deletions: 2 }), false);
});

test("isGateRunStale: code ref differs → stale when verified", () => {
  const run = passedRun("25:752:179:123");
  assert.equal(
    isGateRunStale(run, { filesChanged: 30, additions: 800, deletions: 179, changesetVerified: true }),
    true
  );
});

test("isGateRunStale: code ref matches → not stale", () => {
  const run = passedRun("25:752:179:123");
  assert.equal(
    isGateRunStale(run, { filesChanged: 25, additions: 752, deletions: 179, changesetVerified: true }),
    false
  );
});

test("isGateRunStale: unverified diff counts never invalidate a code verdict (the flap fix)", () => {
  const run = passedRun("25:752:179:123");
  // Counts flapped to 0:0:0 from a shared/unenriched summary — must NOT read stale.
  assert.equal(
    isGateRunStale(run, { filesChanged: 0, additions: 0, deletions: 0, changesetVerified: false }),
    false
  );
});

test("isGateRunStale: plan ref compares against the card's plan hash", () => {
  const run = passedRun("plan:aaaa1111");
  // Same plan content → not stale.
  assert.equal(isGateRunStale(run, { filesChanged: 0, additions: 0, deletions: 0, planContentHash: "plan:aaaa1111" }), false);
  // Plan content changed → stale.
  assert.equal(isGateRunStale(run, { filesChanged: 0, additions: 0, deletions: 0, planContentHash: "plan:bbbb2222" }), true);
});

test("isGateRunStale: plan ref with unknown current plan hash → not stale", () => {
  const run = passedRun("plan:aaaa1111");
  // Plan content not loaded yet (best-effort enrichment) — never invalidate.
  assert.equal(isGateRunStale(run, { filesChanged: 0, additions: 0, deletions: 0 }), false);
});

test("isGateRunStale: plan-gate verdict is not affected by code-diff churn", () => {
  const run = passedRun("plan:aaaa1111");
  // Card shows large code churn (another agent on the shared tree) but the plan is
  // unchanged — the plan review must stay fresh.
  assert.equal(
    isGateRunStale(run, {
      filesChanged: 99,
      additions: 5000,
      deletions: 4000,
      changesetVerified: true,
      planContentHash: "plan:aaaa1111",
    }),
    false
  );
});
