import type Database from "better-sqlite3";
import { z } from "zod";
import { responseSchema, type DecisionOutcome } from "../decisions/core.ts";
import { runSchemaMigration, tableColumns } from "./schema-migration.ts";

export function ensureDecisionSchema(db: Database.Database): void {
  runSchemaMigration(db, () => {
    db.exec(`CREATE TABLE IF NOT EXISTS decision_records (
      decision_key TEXT PRIMARY KEY, family TEXT NOT NULL, owner TEXT NOT NULL,
      policy_key TEXT NOT NULL, result_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
    const columns = tableColumns(db, "card_risk");
    if (columns.size && !columns.has("decision_key")) db.exec("ALTER TABLE card_risk ADD COLUMN decision_key TEXT");
    if (columns.size && !columns.has("decision_policy")) db.exec("ALTER TABLE card_risk ADD COLUMN decision_policy TEXT");
  });
}

const outcomeSchema = z.object({
  kind: z.enum(["accepted", "needs-human", "deferred"]), key: z.string(), policyKey: z.string(),
  reason: z.string().optional(), response: responseSchema.optional(),
  latencyMs: z.number().nonnegative(), retryAt: z.number().optional(),
  attempts: z.number().int().nonnegative().optional(),
});

export function readDecision(db: Database.Database, key: string): DecisionOutcome | undefined {
  const row = db.prepare("SELECT result_json FROM decision_records WHERE decision_key = ?").get(key) as { result_json: string } | undefined;
  return row ? outcomeSchema.parse(JSON.parse(row.result_json)) : undefined;
}

export function writeDecision(db: Database.Database, family: string, owner: string, result: DecisionOutcome): void {
  db.prepare(`INSERT INTO decision_records (decision_key, family, owner, policy_key, result_json)
    VALUES (?, ?, ?, ?, ?) ON CONFLICT(decision_key) DO UPDATE SET result_json = excluded.result_json`)
    .run(result.key, family, owner, result.policyKey, JSON.stringify(result));
}
