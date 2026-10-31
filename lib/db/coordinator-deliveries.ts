import type Database from "better-sqlite3";

export interface CoordinatorDelivery {
  resource: string;
  chatUri?: string;
  messageId?: string;
  turnId?: string;
  pendingMessageId?: string;
  queued?: boolean;
}

export function ensureCoordinatorDeliveriesSchema(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS coordinator_deliveries (
    audit_key TEXT PRIMARY KEY, identity_json TEXT NOT NULL
  )`);
}

export function recordCoordinatorDelivery(db: Database.Database, key: string, identity: CoordinatorDelivery): void {
  db.prepare(`INSERT INTO coordinator_deliveries VALUES (?,?)
    ON CONFLICT(audit_key) DO UPDATE SET identity_json=excluded.identity_json`).run(key, JSON.stringify(identity));
}

export function getCoordinatorDelivery(db: Database.Database, key: string): CoordinatorDelivery | undefined {
  const row = db.prepare("SELECT identity_json FROM coordinator_deliveries WHERE audit_key=?").get(key) as { identity_json: string } | undefined;
  return row ? JSON.parse(row.identity_json) as CoordinatorDelivery : undefined;
}
