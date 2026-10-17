import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import path from "node:path";
import { after, beforeEach, test } from "node:test";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";

import type { OwnershipRecoveryResult } from "../../../../../lib/db/ownership-recovery.ts";
import {
  claimSessionOwnership, getSessionOwnership, ownershipHostChoice,
} from "../../../../../lib/db/session-ownership.ts";

const uri = "copilotcli:/shared";
const owner = "ws://user:owner-password@127.0.0.1:9000/private?token=original-secret";
const chosen = "ws://127.0.0.1:9001/secret-path?token=chosen-secret";
const db = new Database(":memory:");
db.exec(`
  CREATE TABLE session_cache (session_uri TEXT PRIMARY KEY, host_url TEXT NOT NULL);
`);
claimSessionOwnership(db, uri, owner);
claimSessionOwnership(db, uri, chosen);
let calls = 0;
let seen: unknown[];
let result: OwnershipRecoveryResult = { success: false, reason: "stale" };
const key = "__planwerkOwnershipRouteTest";
Object.defineProperty(globalThis, key, {
  configurable: true,
  value: {
    getDb() { return db; },
    rebind(...args: unknown[]) { calls++; seen = args; return result; },
  },
});
const repository = path.resolve(import.meta.dirname, "../../../../..");
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    let source: string | undefined;
    if (specifier === "@/lib/db/schema") source = `export const getDb = () => globalThis["${key}"].getDb();`;
    if (specifier === "@/lib/ahp/ownership-recovery") source = `export async function rebindSessionOwnership(...args) { return globalThis["${key}"].rebind(...args); }`;
    if (source) return { shortCircuit: true, url: `data:text/javascript,${encodeURIComponent(source)}` };
    if (specifier === "next/server") return nextResolve("next/server.js", context);
    if (specifier.startsWith("@/")) {
      return { shortCircuit: true, url: pathToFileURL(path.join(repository, `${specifier.slice(2)}.ts`)).href };
    }
    return nextResolve(specifier, context);
  },
});
const { NextRequest } = await import("next/server.js");
const { GET, POST } = await import("./route.ts");
beforeEach(() => { calls = 0; });
after(() => { hooks.deregister(); Reflect.deleteProperty(globalThis, key); db.close(); });
function request(method: "GET" | "POST", body?: string, headers: Record<string, string> = {}, query = "") {
  return new NextRequest(`http://127.0.0.1:3000/api/ahp/sessions/ownership${query}`, {
    method,
    headers: {
      host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000",
      "sec-fetch-site": "same-origin", ...(method === "POST" ? { "content-type": "application/json" } : {}),
      ...headers,
    },
    ...(body !== undefined ? { body } : {}),
  });
}
const body = () => ({
  sessionUri: uri, hostId: ownershipHostChoice(chosen).hostId,
  expectedRevision: getSessionOwnership(db, uri)!.revision, confirm: true,
});

test("GET returns a client-safe, uncached owner/conflict diagnostic, never secret host URLs", async () => {
  const response = await GET(request("GET", undefined, {}, `?sessionUri=${encodeURIComponent(uri)}`));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const diagnostic = await response.json();
  assert.equal(diagnostic.quarantined, true);
  assert.equal(diagnostic.owner.label, "ws://127.0.0.1:9000");
  assert.equal(diagnostic.conflictingHost.label, "ws://127.0.0.1:9001");
  assert.equal(diagnostic.hosts.length, 2);
  const text = JSON.stringify(diagnostic);
  for (const secret of ["owner-password", "original-secret", "chosen-secret", "/private", "secret-path", "token="]) {
    assert.equal(text.includes(secret), false, secret);
  }
  assert.equal(calls, 0);
});

test("ownership diagnostics reject cross-origin reads and validate missing/unknown targets", async () => {
  assert.equal((await GET(request("GET", undefined, { origin: "https://outside.example" }, "?sessionUri=known"))).status, 403);
  assert.equal((await GET(request("GET"))).status, 400);
  assert.equal((await GET(request("GET", undefined, {}, "?sessionUri=missing"))).status, 404);
  assert.equal(calls, 0);
});

test("rebind requires a local same-origin JSON mutation and explicit confirmation", async () => {
  const forbiddenHeaders: Array<Record<string, string>> = [
    { origin: "https://outside.example" },
    { "sec-fetch-site": "cross-site" },
    { "content-type": "text/plain" },
  ];
  for (const overrides of forbiddenHeaders) {
    assert.equal((await POST(request("POST", JSON.stringify(body()), overrides))).status, 403);
  }
  for (const value of [
    "{", "null", "[]", "{}", JSON.stringify({ ...body(), confirm: false }),
    JSON.stringify({ ...body(), confirm: "true" }), JSON.stringify({ ...body(), expectedRevision: "2" }),
    JSON.stringify({ ...body(), expectedRevision: -1 }), JSON.stringify({ ...body(), expectedRevision: 1.5 }),
    JSON.stringify({ ...body(), hostId: "" }), JSON.stringify({ ...body(), sessionUri: 3 }),
    JSON.stringify({ hostUrl: chosen, sessionUri: uri, confirm: true, expectedRevision: 2 }),
  ]) {
    assert.equal((await POST(request("POST", value))).status, 400, value);
  }
  assert.equal(calls, 0);
});

test("stale revisions and in-flight work are conflicts, not silent rebinding", async () => {
  for (const reason of ["stale", "in-flight", "catalog-missing", "not-quarantined"] as const) {
    result = { success: false, reason };
    const response = await POST(request("POST", JSON.stringify(body())));
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), result);
  }
});

test("unknown choices, unavailable catalogs and missing ownership expose bounded failure responses", async () => {
  for (const [reason, status] of [
    ["unknown-host", 400], ["catalog-unavailable", 503], ["not-found", 404],
  ] as const) {
    result = { success: false, reason };
    const response = await POST(request("POST", JSON.stringify(body())));
    assert.equal(response.status, status);
    assert.deepEqual(await response.json(), result);
  }
});

test("confirmed rebind passes the opaque choice, CAS and cancellation and returns the fresh diagnostic", async () => {
  result = { success: true, ownership: getSessionOwnership(db, uri)! };
  const input = request("POST", JSON.stringify(body()));
  const response = await POST(input);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), result);
  assert.deepEqual(seen![0], body());
  assert.equal(seen![1], input.signal);
});
