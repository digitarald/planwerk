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

  return rows.map((row) => ({
    sessionUri: row.session_uri,
    summary: JSON.parse(row.summary_json),
    enrichment: row.enrichment_json ? JSON.parse(row.enrichment_json) : null,
    updatedAt: row.updated_at,
  }));
}

export function upsertSessionCache(
  hostUrl: string,
  sessionUri: string,
  summary: AHPSessionSummary,
  enrichment?: ChangesetEnrichment | null
): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO session_cache (session_uri, host_url, summary_json, enrichment_json, updated_at)
     VALUES (?, ?, ?, ?, datetime('now'))
     ON CONFLICT(session_uri) DO UPDATE SET
       host_url = excluded.host_url,
       summary_json = excluded.summary_json,
       enrichment_json = COALESCE(excluded.enrichment_json, session_cache.enrichment_json),
       updated_at = datetime('now')`
  ).run(sessionUri, hostUrl, JSON.stringify(summary), enrichment ? JSON.stringify(enrichment) : null);
}

export function removeSessionCache(sessionUri: string): void {
  const db = getDb();
  db.prepare("DELETE FROM session_cache WHERE session_uri = ?").run(sessionUri);
}

export function clearSessionCache(hostUrl: string): void {
  const db = getDb();
  db.prepare("DELETE FROM session_cache WHERE host_url = ?").run(hostUrl);
}
