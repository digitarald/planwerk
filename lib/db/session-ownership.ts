import type Database from "better-sqlite3";
import { createHash } from "node:crypto";

import { runSchemaMigration, tableColumns } from "./schema-migration.ts";

const initialized = new WeakSet<Database.Database>();

export interface OwnershipHostChoice {
  hostId: string;
  label: string;
}

export interface SessionOwnership {
  sessionUri: string;
  quarantined: boolean;
  revision: number;
  owner: OwnershipHostChoice;
  conflictingHost: OwnershipHostChoice | null;
  hosts: OwnershipHostChoice[];
}

export function sessionOwnershipHostId(hostUrl: string): string {
  return createHash("sha256").update(hostUrl).digest("hex");
}

/** Credentials, query tokens, fragments and URL paths never reach diagnostics. */
export function ownershipHostChoice(hostUrl: string): OwnershipHostChoice {
  let label = "Configured host";
  try {
    const url = new URL(hostUrl);
    if (["ws:", "wss:", "http:", "https:"].includes(url.protocol)) {
      label = `${url.protocol}//${url.host}`;
    }
  } catch {}
  return { hostId: sessionOwnershipHostId(hostUrl), label };
}

/** URI-only phase/gate keys cannot safely represent a URI advertised by two hosts. */
export function ensureSessionOwnershipSchema(db: Database.Database): void {
  if (initialized.has(db)) return;
  runSchemaMigration(db, () => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS session_uri_ownership (
        session_uri TEXT PRIMARY KEY,
        host_url TEXT NOT NULL,
        quarantined INTEGER NOT NULL DEFAULT 0,
        conflicting_host_url TEXT,
        revision INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT OR IGNORE INTO session_uri_ownership (session_uri, host_url)
      SELECT session_uri, host_url FROM session_cache WHERE length(trim(host_url)) > 0;
    `);
    if (!tableColumns(db, "session_uri_ownership").has("revision")) {
      db.exec("ALTER TABLE session_uri_ownership ADD COLUMN revision INTEGER NOT NULL DEFAULT 1");
    }
    db.exec(`
      CREATE TABLE IF NOT EXISTS session_uri_ownership_hosts (
        session_uri TEXT NOT NULL,
        host_url TEXT NOT NULL,
        rejected INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (session_uri, host_url)
      );
      INSERT OR IGNORE INTO session_uri_ownership_hosts (session_uri, host_url)
      SELECT session_uri, host_url FROM session_uri_ownership;
      INSERT OR IGNORE INTO session_uri_ownership_hosts (session_uri, host_url)
      SELECT session_uri, conflicting_host_url FROM session_uri_ownership
      WHERE conflicting_host_url IS NOT NULL;
    `);
  });
  initialized.add(db);
}

export function claimSessionOwnership(
  db: Database.Database,
  sessionUri: string,
  hostUrl: string,
): boolean {
  if (!sessionUri.trim() || !hostUrl.trim()) return false;
  ensureSessionOwnershipSchema(db);
  return db.transaction(() => {
    const created = db.prepare(`
      INSERT OR IGNORE INTO session_uri_ownership (session_uri, host_url)
      VALUES (?, ?)
    `).run(sessionUri, hostUrl).changes === 1;
    if (created) {
      db.prepare("DELETE FROM session_uri_ownership_hosts WHERE session_uri = ?").run(sessionUri);
    }
    db.prepare(`
      INSERT OR IGNORE INTO session_uri_ownership_hosts (session_uri, host_url)
      VALUES (?, ?)
    `).run(sessionUri, hostUrl);
    const known = db.prepare(`
      SELECT rejected FROM session_uri_ownership_hosts WHERE session_uri = ? AND host_url = ?
    `).get(sessionUri, hostUrl) as { rejected: number };
    // A deliberate binding rejects all other known advertisers. Reconnects
    // cannot undo it; an as-yet-unknown host still quarantines the URI.
    if (known.rejected) return false;
    db.prepare(`
      UPDATE session_uri_ownership
      SET quarantined = 1, conflicting_host_url = ?, revision = revision + 1,
        updated_at = datetime('now')
      WHERE session_uri = ? AND host_url <> ?
        AND (quarantined = 0 OR conflicting_host_url IS NOT ?)
    `).run(hostUrl, sessionUri, hostUrl, hostUrl);
    return isSessionOwnedByHost(db, sessionUri, hostUrl);
  }).immediate();
}

/** Client-safe diagnostics. In particular, never return persisted host URLs. */
export function getSessionOwnership(
  db: Database.Database,
  sessionUri: string,
): SessionOwnership | null {
  ensureSessionOwnershipSchema(db);
  const row = db.prepare(`
    SELECT host_url, quarantined, conflicting_host_url, revision
    FROM session_uri_ownership WHERE session_uri = ?
  `).get(sessionUri) as {
    host_url: string; quarantined: number; conflicting_host_url: string | null; revision: number;
  } | undefined;
  if (!row) return null;
  const hosts = db.prepare(`
    SELECT host_url FROM session_uri_ownership_hosts WHERE session_uri = ? ORDER BY host_url
  `).all(sessionUri) as Array<{ host_url: string }>;
  return {
    sessionUri,
    quarantined: Boolean(row.quarantined),
    revision: row.revision,
    owner: ownershipHostChoice(row.host_url),
    conflictingHost: row.conflicting_host_url ? ownershipHostChoice(row.conflicting_host_url) : null,
    hosts: hosts.map(({ host_url }) => ownershipHostChoice(host_url)),
  };
}

/** Server-only resolution: a caller cannot introduce a URL through recovery. */
export function resolveSessionOwnershipHost(
  db: Database.Database,
  sessionUri: string,
  hostId: string,
): string | undefined {
  ensureSessionOwnershipSchema(db);
  const hosts = db.prepare(`
    SELECT host_url FROM session_uri_ownership_hosts WHERE session_uri = ?
  `).all(sessionUri) as Array<{ host_url: string }>;
  return hosts.find(({ host_url }) => sessionOwnershipHostId(host_url) === hostId)?.host_url;
}

/** Quarantine survives cache deletion and cannot be silently cleared by reconnecting. */
export function isSessionOwnedByHost(
  db: Database.Database,
  sessionUri: string,
  expectedHostUrl?: string,
): boolean {
  ensureSessionOwnershipSchema(db);
  const row = db.prepare(`
    SELECT host_url, quarantined FROM session_uri_ownership WHERE session_uri = ?
  `).get(sessionUri) as { host_url: string; quarantined: number } | undefined;
  // Legacy rows may be loaded after this module's schema initialization.
  const cached = db.prepare("SELECT host_url FROM session_cache WHERE session_uri = ?")
    .get(sessionUri) as { host_url: string } | undefined;
  const host = row?.host_url ?? cached?.host_url;
  return Boolean(host?.trim() && !row?.quarantined &&
    (!cached || cached.host_url === host) &&
    (expectedHostUrl === undefined || expectedHostUrl === host));
}
