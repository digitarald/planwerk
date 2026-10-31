import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { runSchemaMigration } from "./schema-migration.ts";

export function ensurePlanAnswerSchema(db: Database.Database): void {
  runSchemaMigration(db, () => db.exec(`
    CREATE TABLE IF NOT EXISTS plan_answers (
      host_url TEXT NOT NULL,
      session_uri TEXT NOT NULL,
      request_id TEXT NOT NULL,
      plan_ref TEXT NOT NULL,
      action TEXT NOT NULL CHECK (action IN ('approve', 'feedback')),
      owner_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('reserved', 'consumed', 'ambiguous')),
      detail TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (host_url, session_uri, request_id)
    )
  `));
}

export function claimPlanAnswer(
  db: Database.Database,
  input: { hostUrl: string; sessionUri: string; requestId: string; planRef: string; action: "approve" | "feedback" },
): string | null {
  const ownerId = randomUUID();
  const inserted = db.prepare(`
    INSERT INTO plan_answers (host_url, session_uri, request_id, plan_ref, action, owner_id, status)
    VALUES (?, ?, ?, ?, ?, ?, 'reserved')
    ON CONFLICT DO NOTHING
  `).run(input.hostUrl, input.sessionUri, input.requestId, input.planRef, input.action, ownerId);
  return inserted.changes === 1 ? ownerId : null;
}

export function completePlanAnswer(
  db: Database.Database,
  ownerId: string,
  consumed: boolean,
  detail?: string,
): void {
  const updated = db.prepare(`
    UPDATE plan_answers SET status = ?, detail = ?, updated_at = datetime('now')
    WHERE owner_id = ? AND status = 'reserved'
  `).run(consumed ? "consumed" : "ambiguous", detail ?? null, ownerId);
  if (updated.changes !== 1) throw new Error("Plan answer receipt ownership was lost.");
}
