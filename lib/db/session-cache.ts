import "server-only";

import { getDb } from "./schema";
import type { AHPSessionSummary } from "@/lib/ahp/types";
import type { ChangesetEnrichment } from "@/lib/ahp/changeset-enricher";

export interface CachedSession {
  sessionUri: string;
  summary: AHPSessionSummary;
  enrichment: ChangesetEnrichment | null;
  updatedAt: string;
}

export function getCachedSessions(hostUrl: string): CachedSession[] {
  const db = getDb();
  const rows = db
    .prepare("SELECT session_uri, summary_json, enrichment_json, updated_at FROM session_cache WHERE host_url = ?")
    .all(hostUrl) as Array<{
      session_uri: string;
      summary_json: string;
      enrichment_json: string | null;
      updated_at: string;
    }>;

  return rows.map((row) => {
    let enrichment: ChangesetEnrichment | null = null;
    if (row.enrichment_json) {
      const parsed = JSON.parse(row.enrichment_json);
      // Migrate old cached shape: filePaths → fileChanges
      if (parsed.filePaths && !parsed.fileChanges) {
        parsed.fileChanges = parsed.filePaths.map((path: string) => ({ path, added: 0, removed: 0 }));
        delete parsed.filePaths;
      }
      // AHP 0.6 review fields are absent from older cache rows. Preserve the
      // old enrichment as-is; the next live changeset read supplies opaque IDs.
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
  });
}

// sentinel: pass CLEAR_ENRICHMENT to explicitly null out cached enrichment
const CLEAR_ENRICHMENT = Symbol("clear");
export { CLEAR_ENRICHMENT };

export function upsertSessionCache(
  hostUrl: string,
  sessionUri: string,
  summary: AHPSessionSummary,
  enrichment?: ChangesetEnrichment | null | typeof CLEAR_ENRICHMENT
): void {
  const db = getDb();
  // undefined → preserve existing enrichment (COALESCE)
  // CLEAR_ENRICHMENT or null with no data → explicitly clear
  // ChangesetEnrichment → store new value
  const clearExplicitly = enrichment === CLEAR_ENRICHMENT;
  const enrichmentJson = clearExplicitly ? null : (enrichment ? JSON.stringify(enrichment) : null);
  const sql = clearExplicitly || enrichment
    ? `INSERT INTO session_cache (session_uri, host_url, summary_json, enrichment_json, updated_at)
       VALUES (?, ?, ?, ?, datetime('now'))
       ON CONFLICT(session_uri) DO UPDATE SET
         host_url = excluded.host_url,
         summary_json = excluded.summary_json,
         enrichment_json = excluded.enrichment_json,
         updated_at = datetime('now')`
    : `INSERT INTO session_cache (session_uri, host_url, summary_json, enrichment_json, updated_at)
       VALUES (?, ?, ?, ?, datetime('now'))
       ON CONFLICT(session_uri) DO UPDATE SET
         host_url = excluded.host_url,
         summary_json = excluded.summary_json,
         enrichment_json = COALESCE(excluded.enrichment_json, session_cache.enrichment_json),
         updated_at = datetime('now')`;
  db.prepare(sql).run(sessionUri, hostUrl, JSON.stringify(summary), enrichmentJson);
}

export function removeSessionCache(hostUrl: string, sessionUri: string): void {
  const db = getDb();
  db.prepare("DELETE FROM session_cache WHERE host_url = ? AND session_uri = ?").run(hostUrl, sessionUri);
}

/** Remove cached sessions for a host that are not in the given set of live URIs. */
export function reconcileSessionCache(hostUrl: string, liveSessionUris: Set<string>): void {
  const db = getDb();
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
  const db = getDb();
  db.prepare("DELETE FROM session_cache WHERE host_url = ?").run(hostUrl);
}
