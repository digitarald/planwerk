import "server-only";

import { randomUUID } from "node:crypto";
import { getDb } from "./schema";
import { runSchemaMigration, tableColumns } from "./schema-migration";
import { claimSessionOwnership, ensureSessionOwnershipSchema, isSessionOwnedByHost } from "./session-ownership";
import type { AHPSessionSummary } from "@/lib/ahp/types";
import type { ChangesetEnrichment } from "@/lib/ahp/changeset-enricher";

export interface CachedSession {
  sessionUri: string;
  summary: AHPSessionSummary;
  enrichment: ChangesetEnrichment | null;
  updatedAt: string;
}

const initialized = new WeakSet<object>();

function cacheDb() {
  const db = getDb();
  if (!initialized.has(db)) {
    ensureSessionOwnershipSchema(db);
    runSchemaMigration(db, () => {
      if (!tableColumns(db, "session_cache").has("cache_token")) {
        db.exec("ALTER TABLE session_cache ADD COLUMN cache_token TEXT");
      }
      db.exec("UPDATE session_cache SET cache_token = lower(hex(randomblob(16))) WHERE cache_token IS NULL");
    });
    initialized.add(db);
  }
  return db;
}

function mapCachedSession(row: {
  session_uri: string;
  summary_json: string;
  enrichment_json: string | null;
  updated_at: string;
}): CachedSession {
  let enrichment: ChangesetEnrichment | null = null;
  if (row.enrichment_json) {
    const parsed = JSON.parse(row.enrichment_json);
    if (parsed.filePaths && !parsed.fileChanges) {
      parsed.fileChanges = parsed.filePaths.map((path: string) => ({ path, added: 0, removed: 0 }));
      delete parsed.filePaths;
    }
    if (parsed.changesetReview && !Array.isArray(parsed.changesetReview.files)) {
      delete parsed.changesetReview;
    }
    enrichment = parsed as ChangesetEnrichment;
  }
  return {
    sessionUri: row.session_uri,
    summary: JSON.parse(row.summary_json),
    enrichment,
    updatedAt: row.updated_at,
  };
}

/** Historical cache remains readable; authority must separately reject quarantine. */
export function getCachedSession(hostUrl: string, sessionUri: string): CachedSession | undefined {
  const row = cacheDb().prepare(`
    SELECT session_uri, summary_json, enrichment_json, updated_at
    FROM session_cache WHERE host_url = ? AND session_uri = ?
  `).get(hostUrl, sessionUri) as Parameters<typeof mapCachedSession>[0] | undefined;
  return row ? mapCachedSession(row) : undefined;
}

export function getSessionCacheSnapshot(
  hostUrl: string,
  sessionUri: string,
): (CachedSession & { cacheToken: string }) | null {
  const db = cacheDb();
  if (!isSessionOwnedByHost(db, sessionUri, hostUrl)) return null;
  const row = db.prepare(`
    SELECT session_uri, summary_json, enrichment_json, updated_at, cache_token
    FROM session_cache WHERE host_url = ? AND session_uri = ?
  `).get(hostUrl, sessionUri) as (Parameters<typeof mapCachedSession>[0] & { cache_token: string }) | undefined;
  return row ? { ...mapCachedSession(row), cacheToken: row.cache_token } : null;
}

export function compareAndSwapSessionCache(
  hostUrl: string,
  sessionUri: string,
  expectedCacheToken: string,
  summary: AHPSessionSummary,
  enrichment: ChangesetEnrichment | null,
): boolean {
  const db = cacheDb();
  return db.transaction(() => {
    if (!isSessionOwnedByHost(db, sessionUri, hostUrl) || summary.resource !== sessionUri) return false;
    return db.prepare(`
      UPDATE session_cache SET summary_json = ?, enrichment_json = ?,
        cache_token = ?, updated_at = datetime('now')
      WHERE host_url = ? AND session_uri = ? AND cache_token = ?
    `).run(JSON.stringify(summary), enrichment === null ? null : JSON.stringify(enrichment), randomUUID(),
      hostUrl, sessionUri, expectedCacheToken).changes === 1;
  }).immediate();
}

export function getCachedSessions(hostUrl: string): CachedSession[] {
  const db = cacheDb();
  const rows = db
    .prepare("SELECT session_uri, summary_json, enrichment_json, updated_at FROM session_cache WHERE host_url = ?")
    .all(hostUrl) as Array<{
      session_uri: string;
      summary_json: string;
      enrichment_json: string | null;
      updated_at: string;
    }>;

  return rows.map(mapCachedSession);
}

// sentinel: pass CLEAR_ENRICHMENT to explicitly null out cached enrichment
const CLEAR_ENRICHMENT = Symbol("clear");
export { CLEAR_ENRICHMENT };

export function upsertSessionCache(
  hostUrl: string,
  sessionUri: string,
  summary: AHPSessionSummary,
  enrichment?: ChangesetEnrichment | null | typeof CLEAR_ENRICHMENT
): boolean {
  const db = cacheDb();
  if (summary.resource !== sessionUri) return false;
  // The current tool is live telemetry; a cached copy would be stale on reload.
  const persisted: AHPSessionSummary = { ...summary };
  delete persisted.currentTool;
  return db.transaction(() => {
    if (!claimSessionOwnership(db, sessionUri, hostUrl)) return false;
    // Preserve enrichment on summary-only refreshes; only the sentinel clears it.
    const clearExplicitly = enrichment === CLEAR_ENRICHMENT;
    const enrichmentJson = clearExplicitly ? null : (enrichment ? JSON.stringify(enrichment) : null);
    const sql = clearExplicitly || enrichment
      ? `INSERT INTO session_cache (session_uri, host_url, summary_json, enrichment_json, cache_token, updated_at)
         VALUES (?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT(session_uri) DO UPDATE SET
           summary_json = excluded.summary_json,
           enrichment_json = excluded.enrichment_json,
           cache_token = excluded.cache_token, updated_at = datetime('now')
         WHERE session_cache.host_url = excluded.host_url`
      : `INSERT INTO session_cache (session_uri, host_url, summary_json, enrichment_json, cache_token, updated_at)
         VALUES (?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT(session_uri) DO UPDATE SET
           summary_json = excluded.summary_json,
           enrichment_json = COALESCE(excluded.enrichment_json, session_cache.enrichment_json),
           cache_token = excluded.cache_token, updated_at = datetime('now')
         WHERE session_cache.host_url = excluded.host_url`;
    return db.prepare(sql).run(sessionUri, hostUrl, JSON.stringify(persisted), enrichmentJson, randomUUID()).changes === 1;
  }).immediate();
}

export function removeSessionCache(hostUrl: string, sessionUri: string): void {
  const db = cacheDb();
  db.prepare("DELETE FROM session_cache WHERE host_url = ? AND session_uri = ?").run(hostUrl, sessionUri);
}

/** Remove cached sessions for a host that are not in the given set of live URIs. */
export function reconcileSessionCache(hostUrl: string, liveSessionUris: Set<string>): void {
  const db = cacheDb();
  const cached = db
    .prepare("SELECT session_uri FROM session_cache WHERE host_url = ?")
    .all(hostUrl) as Array<{ session_uri: string }>;
  const deleteStmt = db.prepare("DELETE FROM session_cache WHERE host_url = ? AND session_uri = ?");
  for (const row of cached) {
    if (!liveSessionUris.has(row.session_uri)) {
      deleteStmt.run(hostUrl, row.session_uri);
    }
  }
}

export function clearSessionCache(hostUrl: string): void {
  const db = cacheDb();
  db.prepare("DELETE FROM session_cache WHERE host_url = ?").run(hostUrl);
}
