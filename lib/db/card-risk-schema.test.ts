import assert from "node:assert/strict";
import { test } from "node:test";

import Database from "better-sqlite3";

import { ensureCardRiskSchema } from "./card-risk-schema.ts";

function createLegacyCardRisk(
  db: Database.Database,
  includeDigest = true,
): void {
  db.exec(`
    CREATE TABLE card_phases (
      card_id TEXT PRIMARY KEY,
      phase TEXT NOT NULL
    );
    CREATE TABLE card_risk (
      card_id TEXT PRIMARY KEY,
      risk_level TEXT NOT NULL DEFAULT 'low',
      risk_factors TEXT NOT NULL DEFAULT '[]',
      assessed_at TEXT NOT NULL DEFAULT (datetime('now')),
      assessed_by TEXT NOT NULL DEFAULT 'copilot',
      ${includeDigest ? "risk_digest TEXT," : ""}
      FOREIGN KEY (card_id) REFERENCES card_phases(card_id)
    );
  `);
}

function createMigratingCardRisk(db: Database.Database): void {
  db.exec(`
    CREATE TABLE card_risk_new (
      card_id TEXT PRIMARY KEY,
      risk_level TEXT NOT NULL DEFAULT 'low',
      risk_factors TEXT NOT NULL DEFAULT '[]',
      assessed_at TEXT NOT NULL DEFAULT (datetime('now')),
      assessed_by TEXT NOT NULL DEFAULT 'copilot',
      risk_digest TEXT
    )
  `);
}

test("card risk rebuild preserves every field and restores foreign keys", () => {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  createLegacyCardRisk(db);
  db.exec(`
    INSERT INTO card_phases VALUES
      ('card-1', 'plan'),
      ('card-2', 'build');
    INSERT INTO card_risk VALUES
      ('card-1', 'low', '["docs"]', '2026-01-01', 'copilot', 'digest-1'),
      ('card-2', 'high', '["migration"]', '2026-01-02', 'human', 'digest-2');
  `);

  ensureCardRiskSchema(db);

  assert.equal(db.pragma("foreign_keys", { simple: true }), 1);
  assert.deepEqual(db.prepare(`
    SELECT card_id, risk_level, risk_factors, assessed_at, assessed_by,
      risk_digest
    FROM card_risk ORDER BY card_id
  `).all(), [
    {
      card_id: "card-1",
      risk_level: "low",
      risk_factors: '["docs"]',
      assessed_at: "2026-01-01",
      assessed_by: "copilot",
      risk_digest: "digest-1",
    },
    {
      card_id: "card-2",
      risk_level: "high",
      risk_factors: '["migration"]',
      assessed_at: "2026-01-02",
      assessed_by: "human",
      risk_digest: "digest-2",
    },
  ]);
  assert.deepEqual(db.prepare("PRAGMA foreign_key_list(card_risk)").all(), []);
  db.close();
});

test("card risk rebuild rolls back copy failure and succeeds on retry", () => {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  createLegacyCardRisk(db);
  db.exec(`
    INSERT INTO card_phases VALUES ('card-1', 'plan');
    INSERT INTO card_risk VALUES (
      'card-1', 'medium', '["database"]', '2026-01-03', 'copilot',
      'digest-original'
    );
  `);
  createMigratingCardRisk(db);
  db.exec(`
    INSERT INTO card_risk_new VALUES (
      'stale', 'low', '[]', '2025-01-01', 'copilot', 'stale-digest'
    )
  `);

  assert.throws(
    () => ensureCardRiskSchema(db, {
      afterCreateMigratingTable(database, tableName) {
        database.exec(`
          CREATE TRIGGER fail_card_risk_copy
          BEFORE INSERT ON ${tableName}
          BEGIN
            SELECT RAISE(ABORT, 'injected copy failure');
          END
        `);
      },
    }),
    /injected copy failure/,
  );

  assert.equal(db.pragma("foreign_keys", { simple: true }), 1);
  assert.equal(
    (db.prepare("PRAGMA foreign_key_list(card_risk)").all() as unknown[])
      .length,
    1,
  );
  assert.deepEqual(db.prepare(`
    SELECT card_id, risk_digest FROM card_risk
  `).all(), [
    { card_id: "card-1", risk_digest: "digest-original" },
  ]);
  assert.deepEqual(db.prepare(`
    SELECT card_id, risk_digest FROM card_risk_new
  `).all(), [
    { card_id: "stale", risk_digest: "stale-digest" },
  ]);

  ensureCardRiskSchema(db);
  assert.equal(db.pragma("foreign_keys", { simple: true }), 1);
  assert.deepEqual(db.prepare(`
    SELECT card_id, risk_digest FROM card_risk
  `).all(), [
    { card_id: "card-1", risk_digest: "digest-original" },
  ]);
  assert.equal(
    (db.prepare(`
      SELECT COUNT(*) AS count FROM sqlite_master
      WHERE type = 'table' AND name = 'card_risk_new'
    `).get() as { count: number }).count,
    0,
  );
  db.close();
});

test("card risk migration recovers a temp table left after original drop", () => {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  createMigratingCardRisk(db);
  db.exec(`
    INSERT INTO card_risk_new VALUES (
      'recovered', 'high', '["interrupted"]', '2026-01-04', 'copilot',
      'digest-recovered'
    )
  `);

  ensureCardRiskSchema(db);

  assert.equal(db.pragma("foreign_keys", { simple: true }), 1);
  assert.deepEqual(db.prepare(`
    SELECT card_id, risk_level, risk_digest FROM card_risk
  `).all(), [
    {
      card_id: "recovered",
      risk_level: "high",
      risk_digest: "digest-recovered",
    },
  ]);
  assert.equal(
    (db.prepare(`
      SELECT COUNT(*) AS count FROM sqlite_master
      WHERE type = 'table' AND name = 'card_risk_new'
    `).get() as { count: number }).count,
    0,
  );
  db.close();
});
