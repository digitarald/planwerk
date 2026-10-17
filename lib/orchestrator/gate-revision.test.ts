import assert from "node:assert/strict";
import { test } from "node:test";

import Database from "better-sqlite3";

import { resolveAuthoritativeGateRevision } from "./gate-revision.ts";
import { claimSessionOwnership } from "../db/session-ownership.ts";

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
    evidenceDigest?: string;
    enrichmentEvidenceDigest?: string | null;
    manifestRevision?: string;
    enrichmentManifestRevision?: string;
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
        evidenceDigest: options.evidenceDigest,
        manifestRevision: options.manifestRevision,
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
            evidenceDigest: options.enrichmentEvidenceDigest === null
              ? undefined : options.enrichmentEvidenceDigest ?? options.evidenceDigest,
            manifestRevision: options.enrichmentManifestRevision ?? options.manifestRevision,
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

test("captured byte evidence, not the observation fence, identifies code gate verdicts", () => {
  const db = createDb();
  seed(db, { evidenceDigest: "captured-a", manifestRevision: "manifest-unchanged" });
  const first = resolveAuthoritativeGateRevision(db, "card-1", "build");
  assert.equal(first.ok && first.changesetRef, "source:captured-a");
  assert.equal(first.ok && first.sourceRevision, "captured-a");
  const summary = JSON.parse((db.prepare("SELECT summary_json FROM session_cache").get() as { summary_json: string }).summary_json);
  const enrichment = JSON.parse((db.prepare("SELECT enrichment_json FROM session_cache").get() as { enrichment_json: string }).enrichment_json);
  summary._planwerkRiskFacts.evidenceDigest = "captured-b";
  enrichment._planwerkSource.evidenceDigest = "captured-b";
  db.prepare("UPDATE session_cache SET summary_json = ?, enrichment_json = ?")
    .run(JSON.stringify(summary), JSON.stringify(enrichment));
  const second = resolveAuthoritativeGateRevision(db, "card-1", "build");
  assert.equal(second.ok && second.changesetRef, "source:captured-b");
  assert.equal(summary._planwerkRiskFacts.sourceRevision, "revision-a");
  // Plan review remains scoped to its actual plan content, not unrelated code bytes.
  const plan = resolveAuthoritativeGateRevision(db, "card-1", "plan");
  assert.equal(plan.ok && plan.changesetRef, "plan:hash-a");
  db.close();
});

test("missing/mismatched captured digests and manifests fail closed", () => {
  for (const options of [
    { evidenceDigest: "captured-a", enrichmentEvidenceDigest: null },
    { evidenceDigest: "captured-a", enrichmentEvidenceDigest: "captured-b" },
    { evidenceDigest: "" },
    { manifestRevision: "manifest-a", enrichmentManifestRevision: "manifest-b" },
  ]) {
    const db = createDb();
    seed(db, options);
    assert.equal(resolveAuthoritativeGateRevision(db, "card-1", "build").ok, false);
    db.close();
  }
});

test("a local evidence digest cannot rebind facts after a catalog timestamp invalidates them", () => {
  const db = createDb();
  seed(db, { evidenceDigest: "captured-a" });
  const row = db.prepare("SELECT summary_json FROM session_cache").get() as { summary_json: string };
  const summary = JSON.parse(row.summary_json);
  summary._planwerkRiskFacts.planVersion = "plan-b";
  db.prepare("UPDATE session_cache SET summary_json = ?").run(JSON.stringify(summary));
  assert.equal(resolveAuthoritativeGateRevision(db, "card-1", "build").ok, false);
  assert.equal(resolveAuthoritativeGateRevision(db, "card-1", "plan").ok, false);
  db.close();
});

test("a URI collision rejects both hosts without transferring historical gate authority", () => {
  const db = createDb();
  seed(db, { evidenceDigest: "captured-a" });
  assert.equal(resolveAuthoritativeGateRevision(db, "card-1", "build").ok, true);
  assert.equal(claimSessionOwnership(db, "card-1", "ws://different-host"), false);
  for (const host of ["vscode-local://desktop", "ws://different-host"]) {
    assert.equal(resolveAuthoritativeGateRevision(db, "card-1", "build", host).ok, false);
  }
  db.close();
});
