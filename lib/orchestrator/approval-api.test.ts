import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import type { PermissionRequest } from "@github/copilot-sdk";
import Database from "better-sqlite3";

import { ensureCtoContinuitySchema } from "../db/cto-continuity-schema.ts";
import { CtoContinuityStore } from "../db/cto-continuity-store.ts";
import {
  createCtoPermissionPolicy,
  type CtoPendingApprovalDecision,
} from "./cto-approval.ts";
import {
  handleApprovalDecision,
  listApprovalDisplayMetadata,
} from "./approval-api.ts";

const request: PermissionRequest = {
  kind: "custom-tool",
  toolName: "override_phase",
  toolDescription: "Override phase",
  toolCallId: "call-1",
  args: {
    cardId: "card-1",
    targetPhase: "ship",
    reason: "Gate exception reviewed",
  },
  managedApprovalRequired: false,
};

function decisionRequest(
  body: Record<string, unknown>,
  overrides: Record<string, string> = {},
): Request {
  return new Request(
    "http://127.0.0.1:3000/api/orchestrator/approvals",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        host: "127.0.0.1:3000",
        origin: "http://127.0.0.1:3000",
        "sec-fetch-site": "same-origin",
        ...overrides,
      },
      body: JSON.stringify(body),
    },
  );
}

function pendingHarness(
  now: () => number = Date.now,
  ownerLeaseTtlMs = 1_000,
) {
  const db = new Database(":memory:");
  ensureCtoContinuitySchema(db);
  const store = new CtoContinuityStore(db, now, {
    ownerId: "approval-owner",
    ownerLeaseTtlMs,
  });
  let delivered: CtoPendingApprovalDecision | undefined;
  const policy = createCtoPermissionPolicy({
    store,
    resolveBinding: (toolName, args, sdkSessionId) => ({
      toolName,
      args,
      cardId: "card-1",
      sdkSessionId,
      riskLevel: "high",
      facts: { phase: "review", gateStatus: "passed" },
    }),
    approvalTtlMs: 500,
    onApprovalRequired: (approval) => {
      delivered = approval;
    },
  });
  const sdkDecision = policy.onPermissionRequest(
    request,
    { sessionId: "sdk-1", managedSettingsEnabled: false },
  );
  return {
    db,
    store,
    policy,
    sdkDecision,
    get delivered() {
      return delivered!;
    },
  };
}

test("approval listing exposes display metadata but no decision authority", async () => {
  const harness = pendingHarness();
  const response = listApprovalDisplayMetadata(harness.store);
  const payload = await response.json();
  const serialized = JSON.stringify(payload);

  assert.equal(response.status, 200);
  assert.equal(payload.approvals[0].toolName, "override_phase");
  assert.equal(serialized.includes("approvalId"), false);
  assert.equal(serialized.includes("actionHash"), false);
  assert.equal(serialized.includes("decisionCapability"), false);
  assert.equal(serialized.includes(harness.delivered.decisionCapability), false);

  const atRest = harness.db.prepare(`
    SELECT decision_capability_hash FROM cto_action_approvals
  `).get() as { decision_capability_hash: string };
  assert.match(atRest.decision_capability_hash, /^[a-f0-9]{64}$/);
  assert.notEqual(
    atRest.decision_capability_hash,
    harness.delivered.decisionCapability,
  );

  harness.policy.cancelPending();
  await harness.sdkDecision;
  harness.db.close();
});

test("decision endpoint rejects guessed IDs, bad capabilities, actor spoofing, and cross-origin posts", async () => {
  const harness = pendingHarness();
  const capability = harness.delivered.decisionCapability;

  assert.equal(
    (await handleApprovalDecision(
      decisionRequest({ approvalId: "guessed", decision: "approve" }),
      harness.store,
    )).status,
    400,
  );
  assert.equal(
    (await handleApprovalDecision(
      decisionRequest({ decision: "approve" }),
      harness.store,
    )).status,
    400,
  );
  assert.equal(
    (await handleApprovalDecision(
      decisionRequest({
        decisionCapability: `${capability.slice(0, -1)}x`,
        decision: "approve",
      }),
      harness.store,
    )).status,
    409,
  );
  assert.equal(
    (await handleApprovalDecision(
      decisionRequest({
        decisionCapability: capability,
        decision: "approve",
        actor: "system-administrator",
      }),
      harness.store,
    )).status,
    400,
  );
  assert.equal(
    (await handleApprovalDecision(
      decisionRequest(
        { decisionCapability: capability, decision: "approve" },
        {
          origin: "http://attacker.example",
          "sec-fetch-site": "cross-site",
        },
      ),
      harness.store,
    )).status,
    403,
  );

  harness.policy.cancelPending();
  await harness.sdkDecision;
  harness.db.close();
});

test("a valid capability is bound, server-attributed, and single-use", async () => {
  const harness = pendingHarness();
  const capability = harness.delivered.decisionCapability;

  const response = await handleApprovalDecision(
    decisionRequest({ decisionCapability: capability, decision: "approve" }),
    harness.store,
  );
  assert.equal(response.status, 200);
  assert.equal(
    (await handleApprovalDecision(
      decisionRequest({ decisionCapability: capability, decision: "reject" }),
      harness.store,
    )).status,
    409,
  );
  assert.deepEqual(await harness.sdkDecision, {
    kind: "approve-once",
    approvedInteractively: true,
  });

  const [consumed] = harness.store.listApprovals("consumed");
  assert.equal(consumed.decidedBy, "local-human");
  harness.db.close();
});

test("decision POST on a non-owner connection durably routes to the live owner", async () => {
  fs.mkdirSync(path.join(process.cwd(), ".planwerk"), { recursive: true });
  const dbPath = path.join(
    process.cwd(),
    ".planwerk",
    `approval-route-${randomUUID()}.db`,
  );
  const ownerDb = new Database(dbPath);
  const receiverDb = new Database(dbPath);
  try {
    ownerDb.pragma("journal_mode = WAL");
    ensureCtoContinuitySchema(ownerDb);
    const owner = new CtoContinuityStore(ownerDb, Date.now, {
      ownerId: "approval-owner",
      ownerLeaseTtlMs: 1_000,
    });
    let capability = "";
    const policy = createCtoPermissionPolicy({
      store: owner,
      resolveBinding: (toolName, args, sdkSessionId) => ({
        toolName,
        args,
        cardId: "card-1",
        sdkSessionId,
        riskLevel: "high",
        facts: { phase: "review", gateStatus: "passed" },
      }),
      onApprovalRequired: (approval) => {
        capability = approval.decisionCapability;
      },
    });
    const sdkDecision = policy.onPermissionRequest(
      request,
      { sessionId: "sdk-1", managedSettingsEnabled: false },
    );
    await new Promise((resolve) => setImmediate(resolve));

    ensureCtoContinuitySchema(receiverDb);
    const receiver = new CtoContinuityStore(receiverDb, Date.now, {
      ownerId: "approval-receiver",
      ownerLeaseTtlMs: 1_000,
    });
    const response = await handleApprovalDecision(
      decisionRequest({
        decisionCapability: capability,
        decision: "approve",
      }),
      receiver,
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await sdkDecision, {
      kind: "approve-once",
      approvedInteractively: true,
    });
    assert.equal(owner.listApprovals("consumed").length, 1);
    assert.equal(
      (await handleApprovalDecision(
        decisionRequest({
          decisionCapability: capability,
          decision: "approve",
        }),
        receiver,
      )).status,
      409,
    );
  } finally {
    ownerDb.close();
    receiverDb.close();
    fs.rmSync(dbPath, { force: true });
    fs.rmSync(`${dbPath}-wal`, { force: true });
    fs.rmSync(`${dbPath}-shm`, { force: true });
  }
});

test("expired capabilities and lost waiters fail closed", async () => {
  let now = 10_000;
  const expired = pendingHarness(() => now);
  now = 10_501;
  assert.equal(
    (await handleApprovalDecision(
      decisionRequest({
        decisionCapability: expired.delivered.decisionCapability,
        decision: "approve",
      }),
      expired.store,
    )).status,
    409,
  );
  expired.policy.cancelPending();
  await expired.sdkDecision;
  expired.db.close();

  now = 20_000;
  const ownerLost = pendingHarness(() => now, 100);
  now = 20_101;
  assert.equal(
    (await handleApprovalDecision(
      decisionRequest({
        decisionCapability: ownerLost.delivered.decisionCapability,
        decision: "approve",
      }),
      ownerLost.store,
    )).status,
    409,
  );
  ownerLost.policy.cancelPending();
  await ownerLost.sdkDecision;
  ownerLost.db.close();

  const lost = pendingHarness();
  const capability = lost.delivered.decisionCapability;
  lost.policy.cancelPending();
  await lost.sdkDecision;
  assert.equal(
    (await handleApprovalDecision(
      decisionRequest({ decisionCapability: capability, decision: "approve" }),
      lost.store,
    )).status,
    409,
  );
  lost.db.close();
});
