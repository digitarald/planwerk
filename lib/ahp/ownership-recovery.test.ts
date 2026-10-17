import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { after, afterEach, beforeEach, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { SessionSummary } from "@microsoft/agent-host-protocol";
import Database from "better-sqlite3";

import {
  claimSessionOwnership, getSessionOwnership, isSessionOwnedByHost, ownershipHostChoice,
} from "../db/session-ownership.ts";

const uri = "copilotcli:/shared";
const oldHost = "ws://127.0.0.1:7000/?token=original-secret";
const chosenHost = "ws://127.0.0.1:7001/?token=selected-secret";
const thirdHost = "ws://127.0.0.1:7002";
const sdkSummary: SessionSummary = {
  resource: uri, provider: "copilotcli", title: "Chosen live catalog",
  status: 1, createdAt: "2026-10-17T00:00:00Z", modifiedAt: "2026-10-17T01:00:00Z",
};
let db: Database.Database;
let methods: string[];
let connections: string[];
let shutdowns: number;
let pages: SessionSummary[][];
let onList: (() => void) | undefined;
let connectError: Error | undefined;
const key = "__planwerkOwnershipRecoveryServiceTest";
Object.defineProperty(globalThis, key, {
  configurable: true,
  value: {
    getDb() { return db; },
    async connect(hostUrl: string) {
      connections.push(hostUrl);
      if (connectError) throw connectError;
      let page = 0;
      return {
        client: {
          async request(method: string, params: { channel: string; cursor?: string }) {
            methods.push(method);
            assert.equal(method, "listSessions");
            assert.equal(params.channel, "ahp-root://");
            assert.equal(params.cursor, page === 0 ? undefined : String(page));
            onList?.();
            const items = pages[page++] ?? [];
            return { items, nextCursor: page < pages.length ? String(page) : undefined };
          },
          async subscribe() { assert.fail("Recovery must never subscribe to a live session"); },
          async shutdown() { shutdowns++; },
        },
      };
    },
  },
});
const repository = path.resolve(import.meta.dirname, "../..");
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    let source: string | undefined;
    if (specifier === "server-only") source = "export {}";
    if (specifier === "../db/schema") source = `export const getDb = () => globalThis["${key}"].getDb();`;
    if (specifier === "./endpoint") source = `export const connectInitializedAhpClient = (host) => globalThis["${key}"].connect(host);`;
    if (source) return { shortCircuit: true, url: `data:text/javascript,${encodeURIComponent(source)}` };
    if (specifier.startsWith("@/")) {
      return { shortCircuit: true, url: pathToFileURL(path.join(repository, `${specifier.slice(2)}.ts`)).href };
    }
    if (specifier.startsWith(".") && !path.extname(specifier) && context.parentURL?.startsWith("file:")) {
      const candidate = fileURLToPath(new URL(`${specifier}.ts`, context.parentURL));
      if (existsSync(candidate)) return { shortCircuit: true, url: pathToFileURL(candidate).href };
    }
    return nextResolve(specifier, context);
  },
});
const { rebindSessionOwnership } = await import("./ownership-recovery.ts");
const { beginEvidenceRead, isEvidenceReadCurrent, observeOwnershipRecovery } = await import("./source-binding.ts");
beforeEach(() => {
  db = new Database(":memory:");
  db.exec(`
    CREATE TABLE session_cache (session_uri TEXT PRIMARY KEY, host_url TEXT NOT NULL,
      summary_json TEXT NOT NULL, enrichment_json TEXT, updated_at TEXT);
    CREATE TABLE gate_runs (card_id TEXT, status TEXT);
  `);
  db.prepare("INSERT INTO session_cache VALUES (?, ?, ?, ?, 'before')")
    .run(uri, oldHost, JSON.stringify({ ...sdkSummary, title: "Old owner" }), '{"changesetVerified":true}');
  claimSessionOwnership(db, uri, chosenHost);
  methods = [];
  connections = [];
  shutdowns = 0;
  pages = [[{ ...sdkSummary, resource: "another" }], [sdkSummary]];
  onList = undefined;
  connectError = undefined;
});
afterEach(() => { db.close(); });
after(() => { hooks.deregister(); Reflect.deleteProperty(globalThis, key); });
function input(host = chosenHost) {
  return {
    sessionUri: uri, hostId: ownershipHostChoice(host).hostId,
    expectedRevision: getSessionOwnership(db, uri)!.revision, confirm: true,
  };
}

test("rebind lists all passive catalog pages and broadcasts only after invalidation commits", async () => {
  const oldRead = beginEvidenceRead(oldHost, uri);
  const chosenRead = beginEvidenceRead(chosenHost, uri);
  const observed: string[] = [];
  const stops = [oldHost, chosenHost].map((host) => observeOwnershipRecovery(host, (update) => {
    assert.equal(isSessionOwnedByHost(db, uri, chosenHost), true);
    assert.equal(isSessionOwnedByHost(db, uri, oldHost), false);
    assert.equal(isEvidenceReadCurrent(oldHost, uri, oldRead), false);
    assert.equal(isEvidenceReadCurrent(chosenHost, uri, chosenRead), false);
    assert.equal(update.selectedHostUrl, chosenHost);
    assert.equal(update.session.title, "Chosen live catalog");
    assert.equal(update.revision, getSessionOwnership(db, uri)!.revision);
    const cached = db.prepare("SELECT enrichment_json, summary_json FROM session_cache").get() as {
      enrichment_json: string | null; summary_json: string;
    };
    assert.equal(cached.enrichment_json, null);
    assert.equal(JSON.parse(cached.summary_json)._planwerkRiskFacts, undefined);
    observed.push(host);
  }));
  try {
    assert.equal((await rebindSessionOwnership(input())).success, true);
    assert.deepEqual(methods, ["listSessions", "listSessions"]);
    assert.deepEqual(connections, [chosenHost]);
    assert.equal(shutdowns, 1);
    assert.deepEqual(observed, [oldHost, chosenHost]);
  } finally { stops.forEach((stop) => stop()); }
});

test("missing URI or failed catalog is fail-closed and never leaks URL tokens", async () => {
  pages = [[]];
  assert.deepEqual(await rebindSessionOwnership(input()), { success: false, reason: "catalog-missing" });
  assert.equal(getSessionOwnership(db, uri)!.quarantined, true);
  connectError = new Error(`connection failed: ${chosenHost}`);
  const result = await rebindSessionOwnership(input());
  assert.deepEqual(result, { success: false, reason: "catalog-unavailable" });
  assert.equal(JSON.stringify(result).includes("selected-secret"), false);
});

test("confirmation, stale CAS, unknown hosts and existing mutation owners fail before catalog reads", async () => {
  const request = input();
  assert.deepEqual(await rebindSessionOwnership({ ...request, confirm: false }), { success: false, reason: "confirmation-required" });
  assert.deepEqual(await rebindSessionOwnership({ ...request, expectedRevision: 0 }), { success: false, reason: "stale" });
  assert.deepEqual(await rebindSessionOwnership({ ...request, hostId: ownershipHostChoice(thirdHost).hostId }), { success: false, reason: "unknown-host" });
  db.prepare("INSERT INTO gate_runs VALUES (?, 'running')").run(uri);
  assert.deepEqual(await rebindSessionOwnership(request), { success: false, reason: "in-flight" });
  assert.deepEqual(connections, []);
});

test("a newly observed third host invalidates the CAS while the passive catalog read is pending", async () => {
  onList = () => { claimSessionOwnership(db, uri, thirdHost); };
  assert.deepEqual(await rebindSessionOwnership(input()), { success: false, reason: "stale" });
  assert.equal(getSessionOwnership(db, uri)!.quarantined, true);
  assert.equal(isSessionOwnedByHost(db, uri, chosenHost), false);
});

test("mutation owners acquired during the catalog read are checked again atomically", async () => {
  onList = () => { db.prepare("INSERT INTO gate_runs VALUES (?, 'running')").run(uri); };
  assert.deepEqual(await rebindSessionOwnership(input()), { success: false, reason: "in-flight" });
  assert.equal(getSessionOwnership(db, uri)!.quarantined, true);
});

test("cancellation cannot commit a late catalog result", async () => {
  const controller = new AbortController();
  onList = () => { controller.abort(); };
  assert.deepEqual(await rebindSessionOwnership(input(), controller.signal), {
    success: false, reason: "catalog-unavailable",
  });
  assert.equal(getSessionOwnership(db, uri)!.quarantined, true);
  assert.equal(shutdowns, 1);
});
