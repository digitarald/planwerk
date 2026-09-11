import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import Database from "better-sqlite3";
import type { PermissionRequest } from "@github/copilot-sdk";

import { ensureCtoContinuitySchema } from "../db/cto-continuity-schema.ts";
import {
  CtoContinuityStore,
  type CtoApprovalBinding,
} from "../db/cto-continuity-store.ts";
import {
  approvalBinding,
  createCtoPermissionPolicy,
  decideCtoApproval,
  getCtoTurnTimeoutMs,
  type CtoApprovalScheduler,
  type CtoPendingApprovalDecision,
} from "./cto-approval.ts";

function overrideRequest(
  managedApprovalRequired = false
): PermissionRequest {
  return {
    kind: "custom-tool",
    toolName: "override_phase",
    toolDescription: "Override phase",
    toolCallId: "call-1",
    args: {
      cardId: "card-1",
      targetPhase: "ship",
      reason: "Reviewed",
    },
    managedApprovalRequired,
  };
}

test("turn timeout covers approval TTL with bounded execution overhead", () => {
  const fakeClock = { now: 59_999 };
  assert.equal(getCtoTurnTimeoutMs(60_000), 90_000);
  fakeClock.now = 60_001;
  assert.equal(
    fakeClock.now < getCtoTurnTimeoutMs(60_000),
    true,
    "the SDK turn remains live after the former 60s cutoff",
  );
  assert.equal(getCtoTurnTimeoutMs(10 * 60_000), 10 * 60_000 + 30_000);
  assert.equal(getCtoTurnTimeoutMs(60 * 60_000), 15 * 60_000);
});

test("approval waiter crosses 60s and expires exactly at its TTL", async () => {
  let now = 0;
  const timeouts = new Map<object, { at: number; callback: () => void }>();
  const scheduler: CtoApprovalScheduler & { advance(ms: number): void } = {
    setTimeout(callback, delayMs) {
      const handle = {};
      timeouts.set(handle, { at: now + delayMs, callback });
      return handle;
    },
    clearTimeout(handle) {
      timeouts.delete(handle as object);
    },
    setInterval() {
      return {};
    },
    clearInterval() {},
    advance(ms) {
      const target = now + ms;
      for (const [handle, timer] of [...timeouts]) {
        if (timer.at <= target) {
          now = timer.at;
          timeouts.delete(handle);
          timer.callback();
        }
      }
      now = target;
    },
  };
  const db = new Database(":memory:");
  ensureCtoContinuitySchema(db);
  const store = new CtoContinuityStore(db, () => now, {
    ownerId: "approval-owner",
    ownerLeaseTtlMs: 120_000,
  });
  const policy = createCtoPermissionPolicy({
    store,
    resolveBinding: (toolName, args, sdkSessionId) =>
      approvalBinding(
        toolName,
        args,
        sdkSessionId,
        "high",
        { phase: "review" },
      ),
    approvalTtlMs: 60_001,
    now: () => now,
    scheduler,
  });
  let settled = false;
  const decision = Promise.resolve(policy.onPermissionRequest(
    overrideRequest(),
    { sessionId: "sdk-1" },
  ));
  void decision.then(() => {
    settled = true;
  });

  scheduler.advance(60_000);
  await Promise.resolve();
  assert.equal(settled, false);
  scheduler.advance(1);
  assert.deepEqual(await decision, {
    kind: "reject",
    feedback: "The human approval request expired.",
  });
  assert.equal(store.listApprovals("expired").length, 1);
  db.close();
});

test("high-risk SDK permissions remain pending until a matching human approval", async () => {
  const db = new Database(":memory:");
  ensureCtoContinuitySchema(db);
  const store = new CtoContinuityStore(db);
  const resolveBinding = (
    toolName: string,
    args: Record<string, unknown>,
    sdkSessionId: string
  ) => approvalBinding(
    toolName,
    args,
    sdkSessionId,
    "high",
    { phase: "review", risk: "high", phaseUpdatedAt: "v1" }
  );
  let approvalRequest: CtoPendingApprovalDecision | undefined;
  const policy = createCtoPermissionPolicy({
    store,
    resolveBinding,
    onApprovalRequired: (approval) => {
      approvalRequest = approval;
    },
  });
  const invocation = { sessionId: "sdk-1", managedSettingsEnabled: false };

  const decision = policy.onPermissionRequest(overrideRequest(), invocation);
  await new Promise((resolve) => setImmediate(resolve));
  const [pending] = store.listApprovals("pending");
  assert.equal(pending.cardId, "card-1");
  assert.equal(
    decideCtoApproval(
      store,
      approvalRequest!.decisionCapability,
      "approved",
    )?.status,
    "approved"
  );
  assert.deepEqual(
    await decision,
    { kind: "approve-once", approvedInteractively: true }
  );
  assert.equal(store.listApprovals("consumed").length, 1);

  const abort = new AbortController();
  const secondPolicy = createCtoPermissionPolicy({
    store,
    resolveBinding,
    signal: abort.signal,
  });
  const secondDecision = secondPolicy.onPermissionRequest(
    overrideRequest(),
    invocation
  );
  await new Promise((resolve) => setImmediate(resolve));
  abort.abort();
  assert.deepEqual(
    await secondDecision,
    { kind: "user-not-available" }
  );
  assert.equal(store.listApprovals("pending").length, 0);
  assert.equal(store.listApprovals("expired").length, 1);
  db.close();
});

test("aborted approval cannot be posted or reused by another tool call", async () => {
  const db = new Database(":memory:");
  ensureCtoContinuitySchema(db);
  const store = new CtoContinuityStore(db);
  const resolveBinding = (
    toolName: string,
    args: Record<string, unknown>,
    sdkSessionId: string
  ) => approvalBinding(
    toolName,
    args,
    sdkSessionId,
    "high",
    { phase: "review", risk: "high" }
  );
  const abort = new AbortController();
  let abortedDecisionCapability = "";
  const policy = createCtoPermissionPolicy({
    store,
    resolveBinding,
    signal: abort.signal,
    onApprovalRequired: (approval) => {
      abortedDecisionCapability = approval.decisionCapability;
    },
  });
  const invocation = { sessionId: "sdk-1", managedSettingsEnabled: false };
  const firstDecision = policy.onPermissionRequest(
    overrideRequest(),
    invocation
  );
  await new Promise((resolve) => setImmediate(resolve));
  const [abortedApproval] = store.listApprovals("pending");

  abort.abort();
  assert.deepEqual(await firstDecision, { kind: "user-not-available" });
  assert.equal(
    decideCtoApproval(
      store,
      abortedDecisionCapability,
      "approved",
    ),
    null
  );

  let liveDecisionCapability = "";
  const secondPolicy = createCtoPermissionPolicy({
    store,
    resolveBinding,
    onApprovalRequired: (approval) => {
      liveDecisionCapability = approval.decisionCapability;
    },
  });
  const secondDecision = secondPolicy.onPermissionRequest(
    { ...overrideRequest(), toolCallId: "call-2" } as PermissionRequest,
    invocation
  );
  await new Promise((resolve) => setImmediate(resolve));
  const [liveApproval] = store.listApprovals("pending");
  assert.notEqual(liveApproval.approvalId, abortedApproval.approvalId);
  assert.equal(liveApproval.requestedToolCallId, "call-2");
  assert.equal(
    store.consumeApproval(resolveBinding(
      "override_phase",
      {
        cardId: "card-1",
        targetPhase: "ship",
        reason: "Reviewed",
      },
      "sdk-1"
    ), "call-2"),
    null
  );

  assert.equal(
    decideCtoApproval(
      store,
      liveDecisionCapability,
      "approved",
    )?.status,
    "approved"
  );
  assert.deepEqual(await secondDecision, {
    kind: "approve-once",
    approvedInteractively: true,
  });
  db.close();
});

test("managed approval requirements are never auto-approved", async () => {
  const db = new Database(":memory:");
  ensureCtoContinuitySchema(db);
  const store = new CtoContinuityStore(db);
  const abort = new AbortController();
  const policy = createCtoPermissionPolicy({
    store,
    resolveBinding: (toolName, args, sdkSessionId) =>
      approvalBinding(
        toolName,
        args,
        sdkSessionId,
        "low",
        { phase: "review", risk: "low" }
      ),
    signal: abort.signal,
  });

  const decision = policy.onPermissionRequest(
    overrideRequest(true),
    { sessionId: "sdk-1", managedSettingsEnabled: true }
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(store.listApprovals("pending").length, 1);
  abort.abort();
  assert.deepEqual(
    await decision,
    { kind: "user-not-available" }
  );
  db.close();
});

test("missing authoritative risk fails closed despite client-like request data", async () => {
  const db = new Database(":memory:");
  ensureCtoContinuitySchema(db);
  const store = new CtoContinuityStore(db);
  const policy = createCtoPermissionPolicy({
    store,
    resolveBinding: (): CtoApprovalBinding | null => null,
  });

  assert.deepEqual(
    await policy.onPermissionRequest(
      overrideRequest(),
      { sessionId: "sdk-1", managedSettingsEnabled: false }
    ),
    {
      kind: "reject",
      feedback:
        "No current persisted server-side risk assessment exists for this action.",
    }
  );
  assert.equal(store.listApprovals().length, 0);
  db.close();
});

test("fact changes while waiting invalidate an approval", async () => {
  const db = new Database(":memory:");
  ensureCtoContinuitySchema(db);
  const store = new CtoContinuityStore(db);
  let facts = { phase: "review", risk: "high" };
  let decisionCapability = "";
  const policy = createCtoPermissionPolicy({
    store,
    resolveBinding: (toolName, args, sdkSessionId) =>
      approvalBinding(toolName, args, sdkSessionId, "high", facts),
    onApprovalRequired: (approval) => {
      decisionCapability = approval.decisionCapability;
    },
  });

  const decision = policy.onPermissionRequest(
    overrideRequest(),
    { sessionId: "sdk-1" }
  );
  await new Promise((resolve) => setImmediate(resolve));
  decideCtoApproval(store, decisionCapability, "approved");
  facts = { phase: "ship", risk: "high" };

  assert.deepEqual(await decision, {
    kind: "reject",
    feedback: "Authoritative card facts changed while approval was pending.",
  });
  db.close();
});

test("approval rejection and expiry settle outstanding SDK requests", async () => {
  const db = new Database(":memory:");
  ensureCtoContinuitySchema(db);
  const store = new CtoContinuityStore(db);
  const resolver = (toolName: string, args: Record<string, unknown>, sdkSessionId: string) =>
    approvalBinding(toolName, args, sdkSessionId, "high", { phase: "review" });
  let rejectionCapability = "";
  const rejectedPolicy = createCtoPermissionPolicy({
    store,
    resolveBinding: resolver,
    onApprovalRequired: (approval) => {
      rejectionCapability = approval.decisionCapability;
    },
  });
  const rejected = rejectedPolicy.onPermissionRequest(
    overrideRequest(),
    { sessionId: "sdk-rejected" }
  );
  await new Promise((resolve) => setImmediate(resolve));
  decideCtoApproval(store, rejectionCapability, "rejected");
  assert.equal((await rejected).kind, "reject");

  const expiringPolicy = createCtoPermissionPolicy({
    store,
    resolveBinding: resolver,
    approvalTtlMs: 5,
  });
  const expired = expiringPolicy.onPermissionRequest(
    { ...overrideRequest(), toolCallId: "call-expiry" } as PermissionRequest,
    { sessionId: "sdk-expiry" }
  );
  assert.equal((await expired).kind, "reject");
  assert.equal(store.listApprovals("expired").length, 1);
  db.close();
});

test("a non-owning worker can decide while the owner waiter polls and settles once", async () => {
  fs.mkdirSync(path.join(process.cwd(), ".planwerk"), { recursive: true });
  const dbPath = path.join(
    process.cwd(),
    ".planwerk",
    `cto-approval-test-${randomUUID()}.db`,
  );
  const first = new Database(dbPath);
  const second = new Database(dbPath);
  try {
    first.pragma("journal_mode = WAL");
    ensureCtoContinuitySchema(first);
    const ownerStore = new CtoContinuityStore(first, Date.now, {
      ownerId: "approval-worker-a",
      ownerLeaseTtlMs: 1_000,
    });
    let decisionCapability = "";
    const policy = createCtoPermissionPolicy({
      store: ownerStore,
      resolveBinding: (toolName, args, sdkSessionId) =>
        approvalBinding(
          toolName,
          args,
          sdkSessionId,
          "high",
          { phase: "review" },
        ),
      onApprovalRequired: (approval) => {
        decisionCapability = approval.decisionCapability;
      },
    });
    const decision = Promise.resolve(policy.onPermissionRequest(
      overrideRequest(),
      { sessionId: "sdk-cross-worker" },
    ));
    let settleCount = 0;
    void decision.then(() => {
      settleCount++;
    });
    await new Promise((resolve) => setImmediate(resolve));
    const [pending] = ownerStore.listApprovals("pending");

    ensureCtoContinuitySchema(second);
    const observer = new CtoContinuityStore(second, Date.now, {
      ownerId: "approval-worker-b",
      ownerLeaseTtlMs: 1_000,
    });
    assert.equal(observer.getApproval(pending.approvalId)?.status, "pending");
    assert.equal(
      observer.decideApprovalWithCapability(
        decisionCapability,
        "approved",
      )?.status,
      "approved",
    );
    assert.equal(
      observer.decideApprovalWithCapability(
        decisionCapability,
        "approved",
      ),
      null,
      "the capability is single-use even before owner consumption",
    );
    assert.deepEqual(await decision, {
      kind: "approve-once",
      approvedInteractively: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(settleCount, 1);
    assert.equal(ownerStore.getApproval(pending.approvalId)?.status, "consumed");
  } finally {
    first.close();
    second.close();
    fs.rmSync(dbPath, { force: true });
    fs.rmSync(`${dbPath}-wal`, { force: true });
    fs.rmSync(`${dbPath}-shm`, { force: true });
  }
});
