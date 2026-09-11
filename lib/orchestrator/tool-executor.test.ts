import assert from "node:assert/strict";
import { test } from "node:test";

import Database from "better-sqlite3";
import type { AhpClient } from "@microsoft/agent-host-protocol/client";

import {
  dispatchAndConfirm,
  MessageDispatchAmbiguousError,
} from "../ahp/dispatch-confirmation.ts";
import { ensureCtoContinuitySchema } from "../db/cto-continuity-schema.ts";
import { CtoContinuityStore } from "../db/cto-continuity-store.ts";
import { authorizeAndRunOverride } from "./cto-override-authorization.ts";
import { runLeaseRenewalTick } from "./lease-renewal.ts";
import {
  setCardRiskIfFactsCurrent,
  setCardRiskInDb,
} from "./risk-persistence.ts";
import {
  reassessAndPersistRisk,
} from "./risk-reassessment.ts";
import { getRiskFactsSnapshot } from "./risk-facts.ts";
import {
  persistToolHandlerOutcome,
  toolLeaseFailureOutcome,
} from "./tool-execution-disposition.ts";

test("ambiguous review dispatch is durable and never injected again", async () => {
  const db = new Database(":memory:");
  ensureCtoContinuitySchema(db);
  const store = new CtoContinuityStore(db);
  let injections = 0;
  const idempotencyKey = "review:card-1:call-1";
  const args = { cardId: "card-1", skillId: "plan-review" };
  const client = {
    dispatch() {
      injections++;
    },
    async ping() {
      throw new Error("transport closed after dispatch");
    },
  } as unknown as Pick<AhpClient, "dispatch" | "ping">;
  const dispatchReview = async (ownerId: string) => {
    const claim = store.claimToolExecution<{
      success: boolean;
      message: string;
    }>(
      idempotencyKey,
      "trigger_review",
      args,
      ownerId,
      100
    );
    if (claim.state === "needs-human" || claim.state === "completed") {
      return claim.result;
    }
    if (claim.state !== "claimed") {
      throw new Error(`unexpected claim state: ${claim.state}`);
    }
    await assert.rejects(
      dispatchAndConfirm(
        client,
        "chat:1",
        { type: "test" } as never,
        "Review dispatch is ambiguous"
      ),
      MessageDispatchAmbiguousError
    );
    const result = {
      success: false,
      message: "Review dispatch is ambiguous; human review is required",
    };
    persistToolHandlerOutcome(store, idempotencyKey, ownerId, {
      result,
      disposition: "needs-human",
    });
    return result;
  };

  const first = await dispatchReview("owner-1");
  assert.equal(first.success, false);
  assert.match(first.message, /ambiguous/);

  const retry = await dispatchReview("owner-2");
  assert.deepEqual(retry, first);
  assert.equal(injections, 1);
  assert.equal(
    store.claimToolExecution(
      idempotencyKey,
      "trigger_review",
      args,
      "owner-3",
      100
    ).state,
    "needs-human"
  );
  db.close();
});

function createRiskDb() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE card_phases (
      card_id TEXT PRIMARY KEY,
      phase TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE card_risk (
      card_id TEXT PRIMARY KEY,
      risk_level TEXT NOT NULL,
      risk_factors TEXT NOT NULL,
      assessed_at TEXT NOT NULL DEFAULT (datetime('now')),
      assessed_by TEXT NOT NULL,
      risk_digest TEXT
    );
    CREATE TABLE session_cache (
      session_uri TEXT PRIMARY KEY,
      host_url TEXT NOT NULL,
      summary_json TEXT NOT NULL,
      enrichment_json TEXT,
      updated_at TEXT NOT NULL
    );
  `);
  ensureCtoContinuitySchema(db);
  db.exec(`
    INSERT INTO card_phases (card_id, phase, updated_at)
    VALUES ('card-1', 'review', 'phase-v1');
    INSERT INTO session_cache (
      session_uri, host_url, summary_json, enrichment_json, updated_at
    ) VALUES (
      'card-1', 'http://localhost:1',
      '{"title":"Small documentation fix","changes":{"files":1,"additions":1,"deletions":0},"_planwerkRiskFacts":{"sourceRevision":"source-v1","planVersion":"plan-v1"}}',
      '{"changesetVerified":true,"totalFileCount":1,"additions":1,"deletions":0,"fileChanges":[{"path":"README.md"}],"planContent":"Fix the documentation typo","_planwerkSource":{"sourceRevision":"source-v1","planVersion":"plan-v1"}}',
      'cache-v1'
    );
  `);
  const snapshot = getRiskFactsSnapshot(
    db,
    "http://localhost:1",
    "card-1",
  )!;
  setCardRiskInDb(
    db,
    "card-1",
    "low",
    ["Small change"],
    "copilot",
    snapshot.digest,
  );
  return db;
}

test("low-to-high reassessment is persisted before override authorization", async () => {
  const db = createRiskDb();
  const store = new CtoContinuityStore(db);
  const before = authorizeAndRunOverride({
    db,
    store,
    args: { cardId: "card-1", targetPhase: "ship", reason: "before" },
    sdkSessionId: "sdk-1",
    toolCallId: "before",
    mutate() {},
  });
  assert.equal(before.authorized, true);
  const snapshot = getRiskFactsSnapshot(
    db,
    "http://localhost:1",
    "card-1",
  )!;

  const result = await reassessAndPersistRisk(
    "card-1",
    snapshot,
    async () => ({
      level: "high",
      factors: ["Database migration"],
    }),
    (facts, level, factors, assessedBy) =>
      setCardRiskIfFactsCurrent(db, facts, level, factors, assessedBy),
  );

  assert.equal(result.level, "high");
  assert.equal(
    (db.prepare(`
      SELECT risk_level FROM card_risk WHERE card_id = 'card-1'
    `).get() as { risk_level: string }).risk_level,
    "high",
  );
  const after = authorizeAndRunOverride({
    db,
    store,
    args: { cardId: "card-1", targetPhase: "ship", reason: "after" },
    sdkSessionId: "sdk-1",
    toolCallId: "after",
    mutate() {
      assert.fail("high-risk override must not run without approval");
    },
  });
  assert.deepEqual(after, {
    authorized: false,
    reason: "A current, matching human approval is required.",
  });
  db.close();
});

test("risk reassessment fails retryably when persistence fails", async () => {
  const db = createRiskDb();
  await assert.rejects(
    reassessAndPersistRisk(
      "card-1",
      {
        cardId: "card-1",
        hostUrl: "http://localhost:1",
        input: {
          title: "Harden SDK",
          filesChanged: 20,
          additions: 500,
          deletions: 50,
        },
        digest: "facts-v1",
      },
      async () => ({
        level: "high",
        factors: ["Database migration"],
      }),
      () => {
        throw new Error("disk full");
      },
    ),
    /Failed to persist risk assessment.*disk full/,
  );
  db.close();
});

test("risk reassessment CAS rejects an async authoritative-facts race", async () => {
  const db = createRiskDb();
  const snapshot = getRiskFactsSnapshot(
    db,
    "http://localhost:1",
    "card-1",
  )!;
  let finishAssessment!: () => void;
  const assessmentBlocked = new Promise<void>((resolve) => {
    finishAssessment = resolve;
  });
  const reassessment = reassessAndPersistRisk(
    "card-1",
    snapshot,
    async () => {
      await assessmentBlocked;
      return { level: "high" as const, factors: ["Database migration"] };
    },
    (facts, level, factors, assessedBy) =>
      setCardRiskIfFactsCurrent(db, facts, level, factors, assessedBy),
  );

  db.prepare(`
    UPDATE session_cache
    SET summary_json = '{"title":"Changed while assessing"}',
      updated_at = 'cache-v2'
    WHERE session_uri = 'card-1'
  `).run();
  finishAssessment();

  await assert.rejects(
    reassessment,
    /authoritative facts changed during assessment/,
  );
  assert.equal(
    (db.prepare(`
      SELECT risk_level FROM card_risk WHERE card_id = 'card-1'
    `).get() as { risk_level: string }).risk_level,
    "low",
  );
  db.close();
});

test("risk reassessment CAS rejects an async phase-version race", async () => {
  const db = createRiskDb();
  const snapshot = getRiskFactsSnapshot(
    db,
    "http://localhost:1",
    "card-1",
  )!;
  let finishAssessment!: () => void;
  const assessmentBlocked = new Promise<void>((resolve) => {
    finishAssessment = resolve;
  });
  const reassessment = reassessAndPersistRisk(
    "card-1",
    snapshot,
    async () => {
      await assessmentBlocked;
      return { level: "high" as const, factors: ["Phase changed"] };
    },
    (facts, level, factors, assessedBy) =>
      setCardRiskIfFactsCurrent(db, facts, level, factors, assessedBy),
  );

  db.prepare(`
    UPDATE card_phases SET phase = 'ship', updated_at = 'phase-v2'
    WHERE card_id = 'card-1'
  `).run();
  finishAssessment();

  await assert.rejects(
    reassessment,
    /authoritative facts changed during assessment/,
  );
  db.close();
});

test("tool lease renewal exceptions cancel work and persist ambiguity", async () => {
  const db = createRiskDb();
  const store = new CtoContinuityStore(db);
  const args = { cardId: "card-1", skillId: "plan-review" };
  const key = "review:renewal-failure";
  const owner = "owner-1";
  assert.equal(
    store.claimToolExecution(key, "trigger_review", args, owner, 100).state,
    "claimed",
  );
  store.renewToolExecution = () => {
    throw new Error("injected SQLite renewal failure");
  };
  const state: { failure?: unknown } = {};
  let cancelled = false;
  assert.doesNotThrow(() => runLeaseRenewalTick(
    state,
    () => store.renewToolExecution(key, owner, 100),
    () => {
      cancelled = true;
    },
    "Tool execution lease ownership was lost.",
  ));
  assert.equal(cancelled, true);
  const outcome = toolLeaseFailureOutcome("trigger_review", state.failure);
  persistToolHandlerOutcome(store, key, owner, outcome);
  assert.match(outcome.result.message, /lease renewal failed.*human review/i);
  assert.equal(
    store.claimToolExecution(
      key,
      "trigger_review",
      args,
      "other-owner",
      100,
    ).state,
    "needs-human",
  );
  db.close();
});
