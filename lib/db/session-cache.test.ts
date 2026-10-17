import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { after, beforeEach, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import Database from "better-sqlite3";

import type { AHPSessionSummary } from "../ahp/types.ts";
import type { ChangesetEnrichment } from "../ahp/changeset-enricher.ts";
import { isSessionOwnedByHost } from "./session-ownership.ts";

const db = new Database(":memory:");
db.exec(`
  CREATE TABLE session_cache (
    session_uri TEXT PRIMARY KEY, host_url TEXT NOT NULL, summary_json TEXT NOT NULL,
    enrichment_json TEXT, updated_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE card_phases (card_id TEXT PRIMARY KEY, phase TEXT);
  CREATE TABLE heartbeat_log (card_id TEXT, detail TEXT);
`);
const key = "__planwerkSessionCacheSafetyTest";
Object.defineProperty(globalThis, key, { value: db, configurable: true });
const root = path.resolve(import.meta.dirname, "../..");
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    let source: string | undefined;
    if (specifier === "server-only") source = "export {}";
    if (specifier === "./schema") source = `export const getDb = () => globalThis["${key}"];`;
    if (source) return { shortCircuit: true, url: `data:text/javascript,${encodeURIComponent(source)}` };
    if (specifier.startsWith("@/")) {
      return { shortCircuit: true, url: pathToFileURL(path.join(root, `${specifier.slice(2)}.ts`)).href };
    }
    if (specifier.startsWith(".") && !path.extname(specifier) && context.parentURL?.startsWith("file:")) {
      const candidate = fileURLToPath(new URL(`${specifier}.ts`, context.parentURL));
      if (existsSync(candidate)) return { shortCircuit: true, url: pathToFileURL(candidate).href };
    }
    return nextResolve(specifier, context);
  },
});
const {
  upsertSessionCache, getCachedSession, getCachedSessions, getSessionCacheSnapshot,
  compareAndSwapSessionCache, removeSessionCache, reconcileSessionCache, clearSessionCache,
  CLEAR_ENRICHMENT,
} = await import("./session-cache.ts");

const URI = "copilotcli:/shared-uri";
const HOST = "ws://first-host";
const OTHER = "ws://second-host";
const summary = (title = "Original") => ({ resource: URI, title }) as AHPSessionSummary;
const enrichment = { changesetVerified: true, totalFileCount: 1 } as ChangesetEnrichment;

beforeEach(() => {
  // Initialize migrations before resetting durable ownership between isolated cases.
  getCachedSessions(HOST);
  db.exec("DELETE FROM session_cache; DELETE FROM session_uri_ownership; DELETE FROM card_phases; DELETE FROM heartbeat_log;");
});
after(() => {
  hooks.deregister();
  Reflect.deleteProperty(globalThis, key);
  db.close();
});

test("a second host cannot overwrite URI-owned cache, phase progress, or audit", () => {
  assert.equal(upsertSessionCache(HOST, URI, summary(), enrichment), true);
  db.prepare("INSERT INTO card_phases VALUES (?, 'review')").run(URI);
  db.prepare("INSERT INTO heartbeat_log VALUES (?, 'prior decision')").run(URI);
  assert.equal(upsertSessionCache(OTHER, URI, summary("Impersonating"),
    CLEAR_ENRICHMENT as Parameters<typeof upsertSessionCache>[3]), false);
  assert.equal(getCachedSession(HOST, URI)?.summary.title, "Original");
  assert.equal(getCachedSession(OTHER, URI), undefined);
  assert.equal(isSessionOwnedByHost(db, URI, HOST), false);
  assert.equal(isSessionOwnedByHost(db, URI, OTHER), false);
  assert.equal(getSessionCacheSnapshot(HOST, URI), null);
  assert.equal(upsertSessionCache(HOST, URI, summary("No silent unquarantine")), false);
  assert.deepEqual(db.prepare("SELECT * FROM card_phases").get(), { card_id: URI, phase: "review" });
  assert.deepEqual(db.prepare("SELECT * FROM heartbeat_log").get(), { card_id: URI, detail: "prior decision" });
});

test("ownership quarantine survives removal and reconciliation; foreign deletes cannot remove owner data", () => {
  upsertSessionCache(HOST, URI, summary(), enrichment);
  removeSessionCache(OTHER, URI);
  assert.ok(getCachedSession(HOST, URI));
  reconcileSessionCache(OTHER, new Set());
  clearSessionCache(OTHER);
  assert.ok(getCachedSession(HOST, URI));
  upsertSessionCache(OTHER, URI, summary("Collision"));
  removeSessionCache(HOST, URI);
  assert.equal(upsertSessionCache(OTHER, URI, summary()), false);
  assert.equal(upsertSessionCache(HOST, URI, summary()), false);
  assert.equal(getCachedSession(HOST, URI), undefined);
});

test("first-owner reservation survives clean cache deletion", () => {
  upsertSessionCache(HOST, URI, summary());
  clearSessionCache(HOST);
  assert.equal(upsertSessionCache(OTHER, URI, summary()), false);
  assert.equal(upsertSessionCache(HOST, URI, summary()), false);
});

test("CAS permits explicit invalidation and rejects stale, deleted, recreated, wrong-host or quarantined captures", () => {
  upsertSessionCache(HOST, URI, summary(), enrichment);
  const first = getSessionCacheSnapshot(HOST, URI)!;
  assert.equal(compareAndSwapSessionCache(HOST, URI, first.cacheToken, summary(), null), true);
  const invalidated = getSessionCacheSnapshot(HOST, URI)!;
  assert.equal(invalidated.enrichment, null);
  assert.notEqual(invalidated.cacheToken, first.cacheToken);
  assert.equal(compareAndSwapSessionCache(HOST, URI, first.cacheToken, summary(), enrichment), false);
  upsertSessionCache(HOST, URI, summary());
  assert.equal(compareAndSwapSessionCache(HOST, URI, invalidated.cacheToken, summary(), enrichment), false);
  const latest = getSessionCacheSnapshot(HOST, URI)!;
  assert.equal(compareAndSwapSessionCache(OTHER, URI, latest.cacheToken, summary(), enrichment), false);
  removeSessionCache(HOST, URI);
  upsertSessionCache(HOST, URI, summary());
  assert.equal(compareAndSwapSessionCache(HOST, URI, latest.cacheToken, summary(), enrichment), false);
  const recreated = getSessionCacheSnapshot(HOST, URI)!;
  upsertSessionCache(OTHER, URI, summary());
  assert.equal(compareAndSwapSessionCache(HOST, URI, recreated.cacheToken, summary(), enrichment), false);
});

test("ordinary refresh preserves enrichment and indexed single-row reads are host-scoped", () => {
  upsertSessionCache(HOST, URI, summary(), enrichment);
  upsertSessionCache(HOST, URI, summary("Updated"));
  assert.equal(getCachedSession(HOST, URI)?.enrichment?.changesetVerified, true);
  assert.equal(getCachedSession(OTHER, URI), undefined);
  assert.deepEqual(getCachedSessions(HOST), [getCachedSession(HOST, URI)]);
  upsertSessionCache(HOST, URI, summary(), CLEAR_ENRICHMENT as Parameters<typeof upsertSessionCache>[3]);
  assert.equal(getCachedSession(HOST, URI)?.enrichment, null);
  assert.equal(upsertSessionCache(HOST, URI, { resource: "different" } as AHPSessionSummary), false);
});
