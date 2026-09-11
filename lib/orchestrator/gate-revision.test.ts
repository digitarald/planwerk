import assert from "node:assert/strict";
import { test } from "node:test";

import Database from "better-sqlite3";

import { resolveAuthoritativeGateRevision } from "./gate-revision.ts";

function createDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE session_cache (
      session_uri TEXT PRIMARY KEY,
      host_url TEXT NOT NULL,
      summary_json TEXT NOT NULL,
      enrichment_json TEXT
    );
  `);
  return db;
}

function seed(
  db: Database.Database,
  options: {
    sourceRevision?: string;
    enrichmentRevision?: string;
    planContentHash?: string;
    enrichment?: boolean;
  } = {},
): void {
  const sourceRevision = options.sourceRevision ?? "revision-a";
  const enrichmentRevision = options.enrichmentRevision ?? sourceRevision;
  db.prepare(`
    INSERT INTO session_cache (
      session_uri, host_url, summary_json, enrichment_json
    ) VALUES (?, ?, ?, ?)
  `).run(
    "card-1",
    "vscode-local://desktop",
    JSON.stringify({
      resource: "card-1",
      _planwerkRiskFacts: {
        sourceRevision,
        planVersion: "plan-a",
      },
    }),
    options.enrichment === false
      ? null
      : JSON.stringify({
          changesetVerified: true,
          totalFileCount: 1,
          additions: 2,
          deletions: 1,
          planContentHash: options.planContentHash ?? "plan:hash-a",
          _planwerkSource: {
            sourceRevision: enrichmentRevision,
            planVersion: "plan-a",
          },
        }),
  );
}

test("authoritative source and plan revisions require bound non-empty facts", () => {
  const db = createDb();
  seed(db);
  assert.deepEqual(
    resolveAuthoritativeGateRevision(
      db,
      "card-1",
      "build",
      "vscode-local://desktop",
    ),
    {
      ok: true,
      changesetRef: "source:revision-a",
      sourceRevision: "revision-a",
      hostUrl: "vscode-local://desktop",
    },
  );
  assert.equal(
    resolveAuthoritativeGateRevision(db, "card-1", "plan").ok,
    true,
  );
  db.close();
});

test("missing, unavailable, empty, and mismatched current facts fail closed", () => {
  const cases = [
    {
      name: "missing cache",
      setup() {},
    },
    {
      name: "unavailable enrichment",
      setup(db: Database.Database) {
        seed(db, { enrichment: false });
      },
    },
    {
      name: "empty source revision",
      setup(db: Database.Database) {
        seed(db, { sourceRevision: " " });
      },
    },
    {
      name: "mismatched enrichment",
      setup(db: Database.Database) {
        seed(db, { enrichmentRevision: "revision-b" });
      },
    },
  ] as const;

  for (const scenario of cases) {
    const db = createDb();
    scenario.setup(db);
    const result = resolveAuthoritativeGateRevision(
      db,
      "card-1",
      "build",
      "vscode-local://desktop",
    );
    assert.equal(result.ok, false, scenario.name);
    db.close();
  }
});

test("plan revision and host binding fail closed independently", () => {
  const db = createDb();
  seed(db, { planContentHash: "" });
  assert.equal(
    resolveAuthoritativeGateRevision(db, "card-1", "plan").ok,
    false,
  );
  assert.equal(
    resolveAuthoritativeGateRevision(
      db,
      "card-1",
      "build",
      "ws://different-host",
    ).ok,
    false,
  );
  db.close();
});
