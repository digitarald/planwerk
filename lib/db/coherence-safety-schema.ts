import type Database from "better-sqlite3";

import { runSchemaMigration, tableColumns } from "./schema-migration.ts";
import { ensureSessionOwnershipSchema } from "./session-ownership.ts";

const initialized = new WeakSet<Database.Database>();

export function ensureCoherenceSafetySchema(db: Database.Database): void {
  if (initialized.has(db)) return;
  ensureSessionOwnershipSchema(db);
  runSchemaMigration(db, () => {
    const columns = tableColumns(db, "coherence_conflicts");
    for (const [name, definition] of [
      ["host_url", "TEXT"],
      ["deferral_reason", "TEXT"],
      ["wake_condition", "TEXT"],
      ["retry_at_ms", "INTEGER"],
      ["failure_attempts", "INTEGER NOT NULL DEFAULT 0"],
      ["activation_key", "TEXT"],
    ]) {
      if (!columns.has(name)) db.exec(`ALTER TABLE coherence_conflicts ADD COLUMN ${name} ${definition}`);
    }
    db.exec(`
      UPDATE coherence_conflicts
      SET host_url = (
        SELECT min(host_url) FROM session_uri_ownership
        WHERE session_uri IN (coherence_conflicts.card_a, coherence_conflicts.card_b)
        HAVING count(DISTINCT host_url) = 1 AND max(quarantined) = 0
      )
      WHERE host_url IS NULL;
      CREATE INDEX IF NOT EXISTS idx_coherence_host ON coherence_conflicts(host_url, status);
    `);
  });
  initialized.add(db);
}
