import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import Database from "better-sqlite3";

const workerScript = `
  import Database from "better-sqlite3";
  import { ensureReviewRunSchema } from "./lib/db/review-run-schema.ts";
  import { ensureCtoContinuitySchema } from "./lib/db/cto-continuity-schema.ts";
  import { ensureSdkObservabilitySchema } from "./lib/db/sdk-observability-schema.ts";
  import { ensureWorkLeaseSchema } from "./lib/db/work-lease-schema.ts";
  const [dbPath, startAt] = process.argv.slice(1);
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(startAt) - Date.now())));
  const db = new Database(dbPath);
  db.pragma("busy_timeout = 5000");
  db.pragma("journal_mode = WAL");
  ensureReviewRunSchema(db);
  ensureCtoContinuitySchema(db);
  ensureSdkObservabilitySchema(db);
  ensureWorkLeaseSchema(db);
  db.close();
`;

function runMigrationWorker(
  dbPath: string,
  startAt: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "--experimental-strip-types",
        "--input-type=module",
        "--eval",
        workerScript,
        dbPath,
        String(startAt),
      ],
      { cwd: process.cwd(), stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`migration worker exited ${code}: ${stderr}`));
    });
  });
}

test("concurrent workers safely upgrade one legacy database", async () => {
  const workingDirectory = path.join(
    process.cwd(),
    ".planwerk",
    `schema-concurrency-${randomUUID()}`,
  );
  const databaseDirectory = path.join(workingDirectory, ".planwerk");
  fs.mkdirSync(databaseDirectory, { recursive: true });
  const dbPath = path.join(databaseDirectory, "planwerk.db");
  const seed = new Database(dbPath);
  seed.pragma("journal_mode = WAL");
  seed.exec(`
    CREATE TABLE review_runs (
      id INTEGER PRIMARY KEY,
      card_id TEXT NOT NULL,
      skill_id TEXT NOT NULL,
      phase_transition TEXT NOT NULL,
      status TEXT NOT NULL,
      verdict_summary TEXT
    );
    CREATE TABLE cto_sdk_sessions (
      singleton_key TEXT PRIMARY KEY,
      sdk_session_id TEXT NOT NULL,
      model_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE cto_action_approvals (
      approval_id TEXT PRIMARY KEY,
      action_hash TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      card_id TEXT,
      sdk_session_id TEXT NOT NULL,
      risk_level TEXT NOT NULL,
      facts_json TEXT NOT NULL,
      requested_by TEXT NOT NULL,
      status TEXT NOT NULL,
      expires_at_ms INTEGER NOT NULL,
      created_at_ms INTEGER NOT NULL
    );
    CREATE TABLE sdk_observability_events (
      sdk_event_id TEXT PRIMARY KEY,
      sdk_session_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      parent_event_id TEXT,
      event_timestamp TEXT NOT NULL
    );
  `);
  seed.close();

  try {
    const startAt = Date.now() + 300;
    await Promise.all([
      runMigrationWorker(dbPath, startAt),
      runMigrationWorker(dbPath, startAt),
    ]);

    const db = new Database(dbPath);
    const columns = (table: string) =>
      new Set(
        (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
          name: string;
        }>).map(({ name }) => name),
      );
    assert.equal(columns("review_runs").has("chat_cleanup_last_attempt_at"), true);
    assert.equal(columns("review_runs").has("start_owner_id"), true);
    assert.equal(columns("review_runs").has("start_lease_expires_at_ms"), true);
    assert.equal(columns("cto_sdk_sessions").has("deletion_token"), true);
    assert.equal(
      columns("cto_action_approvals").has("decision_capability_hash"),
      true,
    );
    assert.equal(columns("sdk_observability_events").has("ingested_at"), true);
    assert.equal(
      columns("cto_tool_executions").has("attempt_count"),
      true,
    );
    db.close();
  } finally {
    fs.rmSync(workingDirectory, { recursive: true, force: true });
  }
});
