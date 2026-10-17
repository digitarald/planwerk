import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

import type { AHPSessionSummary } from "../ahp/types.ts";
import {
  ensureSessionOwnershipSchema,
  getSessionOwnership,
  resolveSessionOwnershipHost,
  type SessionOwnership,
} from "./session-ownership.ts";
import { runSchemaMigration, tableColumns } from "./schema-migration.ts";

export type OwnershipRecoveryFailure =
  | "not-found" | "not-quarantined" | "stale" | "unknown-host"
  | "in-flight" | "catalog-missing" | "catalog-unavailable" | "confirmation-required";

export type OwnershipRecoveryResult =
  | { success: true; ownership: SessionOwnership }
  | { success: false; reason: OwnershipRecoveryFailure };

const initialized = new WeakSet<Database.Database>();
function ensureRecoverySchema(db: Database.Database): void {
  ensureSessionOwnershipSchema(db);
  if (initialized.has(db)) return;
  runSchemaMigration(db, () => {
    if (!tableColumns(db, "session_cache").has("cache_token")) {
      db.exec("ALTER TABLE session_cache ADD COLUMN cache_token TEXT");
    }
    db.exec(`
      CREATE TABLE IF NOT EXISTS session_ownership_recovery_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_uri TEXT NOT NULL,
        previous_host_url TEXT NOT NULL,
        selected_host_url TEXT NOT NULL,
        previous_revision INTEGER NOT NULL,
        revision INTEGER NOT NULL,
        invalidated_authority_json TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  });
  initialized.add(db);
}

function hasTable(db: Database.Database, table: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

function relatedRows(db: Database.Database, table: string, where: string, ...args: string[]): unknown[] {
  return hasTable(db, table) ? db.prepare(`SELECT * FROM ${table} WHERE ${where}`).all(...args) : [];
}

/** Do not retarget durable mutation owners, even if their leases have expired. */
export function hasOwnershipRecoveryInFlight(db: Database.Database, sessionUri: string): boolean {
  for (const [table, where, args] of [
    ["gate_runs", "card_id = ? AND status IN ('running', 'dispatching')", [sessionUri]],
    ["review_runs", `card_id = ? AND status IN
      ('pending', 'dispatching', 'injected', 'extracting', 'ambiguous', 'running')`, [sessionUri]],
    ["coherence_conflicts", "(card_a = ? OR card_b = ?) AND status = 'reviewing'", [sessionUri, sessionUri]],
    // Tool execution rows have no target-card identity. Conservatively block
    // while any CTO write is running/ambiguous rather than guess its target.
    ["cto_tool_executions", "status IN ('running', 'needs-human')", []],
  ] as const) {
    if (hasTable(db, table) && db.prepare(`SELECT 1 FROM ${table} WHERE ${where} LIMIT 1`).get(...args)) {
      return true;
    }
  }
  if (hasTable(db, "review_chat_cleanups") && db.prepare(`
    SELECT 1 FROM review_chat_cleanups
    WHERE status <> 'completed' AND review_run_id IN (
      SELECT id FROM review_runs WHERE card_id = ?
    ) LIMIT 1
  `).get(sessionUri)) return true;
  return false;
}

/** Only called with a fresh, passive catalog observation of the selected host. */
export function recoverSessionOwnership(
  db: Database.Database,
  input: {
    sessionUri: string;
    hostId: string;
    expectedRevision: number;
    confirm: boolean;
    summary: AHPSessionSummary;
  },
): OwnershipRecoveryResult {
  ensureRecoverySchema(db);
  return db.transaction((): OwnershipRecoveryResult => {
    if (input.confirm !== true) return { success: false, reason: "confirmation-required" };
    const ownership = getSessionOwnership(db, input.sessionUri);
    if (!ownership) return { success: false, reason: "not-found" };
    if (ownership.revision !== input.expectedRevision) return { success: false, reason: "stale" };
    if (!ownership.quarantined) return { success: false, reason: "not-quarantined" };
    const selectedHost = resolveSessionOwnershipHost(db, input.sessionUri, input.hostId);
    if (!selectedHost) return { success: false, reason: "unknown-host" };
    if (input.summary.resource !== input.sessionUri) return { success: false, reason: "catalog-missing" };
    if (hasOwnershipRecoveryInFlight(db, input.sessionUri)) return { success: false, reason: "in-flight" };

    const previous = db.prepare("SELECT host_url FROM session_uri_ownership WHERE session_uri = ?")
      .get(input.sessionUri) as { host_url: string };
    const authority = {
      gates: relatedRows(db, "gate_runs", "card_id = ?", input.sessionUri),
      reviews: relatedRows(db, "review_runs", "card_id = ?", input.sessionUri),
      risk: relatedRows(db, "card_risk", "card_id = ?", input.sessionUri),
      coherence: relatedRows(db, "coherence_conflicts", "card_a = ? OR card_b = ?", input.sessionUri, input.sessionUri),
      approvals: relatedRows(db, "cto_action_approvals", "card_id = ? AND status IN ('pending', 'approved')", input.sessionUri),
    };
    const changed = db.prepare(`
      UPDATE session_uri_ownership SET host_url = ?, quarantined = 0,
        conflicting_host_url = NULL, revision = revision + 1, updated_at = datetime('now')
      WHERE session_uri = ? AND revision = ? AND quarantined = 1
    `).run(selectedHost, input.sessionUri, input.expectedRevision).changes;
    if (changed !== 1) return { success: false, reason: "stale" };
    db.prepare(`
      UPDATE session_uri_ownership_hosts SET rejected = CASE WHEN host_url = ? THEN 0 ELSE 1 END
      WHERE session_uri = ?
    `).run(selectedHost, input.sessionUri);

    // Copy catalog facts only. No cached evidence or pending input from the
    // previous owner may survive.
    const summary = { ...input.summary } as AHPSessionSummary & {
      _planwerkRiskFacts?: unknown; _planwerkAHPSourceRevision?: unknown;
    };
    delete summary._planwerkRiskFacts;
    db.prepare(`
      INSERT INTO session_cache (session_uri, host_url, summary_json, enrichment_json, cache_token, updated_at)
      VALUES (?, ?, ?, NULL, ?, datetime('now'))
      ON CONFLICT(session_uri) DO UPDATE SET host_url = excluded.host_url,
        summary_json = excluded.summary_json, enrichment_json = NULL,
        cache_token = excluded.cache_token, updated_at = excluded.updated_at
    `).run(input.sessionUri, selectedHost, JSON.stringify(summary), randomUUID());
    if (hasTable(db, "card_risk")) {
      db.prepare("DELETE FROM card_risk WHERE card_id = ?").run(input.sessionUri);
    }
    // Keep original outputs, verdicts and changeset refs as historical evidence,
    // but never let even a same-hash plan reuse the old host's passed verdict.
    if (hasTable(db, "gate_runs")) {
      db.prepare("UPDATE gate_runs SET status = 'failed' WHERE card_id = ?").run(input.sessionUri);
    }
    if (hasTable(db, "review_runs")) {
      db.prepare("UPDATE review_runs SET status = 'cancelled' WHERE card_id = ?").run(input.sessionUri);
    }
    if (hasTable(db, "coherence_conflicts")) {
      const columns = tableColumns(db, "coherence_conflicts");
      const resetColumns = [
        "activation_key", "dismissed_signature", "review_owner_id",
        "review_lease_expires_at_ms", "deferral_reason", "wake_condition", "retry_at_ms",
      ].filter((column) => columns.has(column)).map((column) => `, ${column} = NULL`).join("");
      db.prepare(`
        UPDATE coherence_conflicts SET status = 'detected',
          signature = ? || ':' || signature, resolved_at = NULL, resolved_by = NULL
          ${columns.has("host_url") ? `, host_url = (
            SELECT min(host_url) FROM session_uri_ownership
            WHERE session_uri IN (coherence_conflicts.card_a, coherence_conflicts.card_b)
            HAVING count(*) = 2 AND count(DISTINCT host_url) = 1 AND max(quarantined) = 0
          )` : ""}
          ${resetColumns}
          ${columns.has("failure_attempts") ? ", failure_attempts = 0" : ""}
        WHERE card_a = ? OR card_b = ?
      `).run(`ownership-recovery:${input.expectedRevision + 1}`, input.sessionUri, input.sessionUri);
    }
    if (hasTable(db, "cto_action_approvals")) {
      db.prepare(`
        UPDATE cto_action_approvals SET status = 'expired'
        WHERE card_id = ? AND status IN ('pending', 'approved')
      `).run(input.sessionUri);
    }
    db.prepare(`
      INSERT INTO session_ownership_recovery_audit
        (session_uri, previous_host_url, selected_host_url, previous_revision, revision, invalidated_authority_json)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(input.sessionUri, previous.host_url, selectedHost, input.expectedRevision,
      input.expectedRevision + 1, JSON.stringify(authority));
    return { success: true, ownership: getSessionOwnership(db, input.sessionUri)! };
  }).immediate();
}
