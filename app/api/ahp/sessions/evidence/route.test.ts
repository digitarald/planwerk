import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { after, test } from "node:test";
import { pathToFileURL } from "node:url";
import path from "node:path";
import type { SessionEvidenceResult } from "../../../../../lib/ahp/session-evidence.ts";

let result: SessionEvidenceResult = { success: false, reason: "changed" };
let calls = 0;
let seen: unknown[];
const key = "__planwerkEvidenceRouteTest";
Object.defineProperty(globalThis, key, {
  value: {
    refresh(...args: unknown[]) { calls++; seen = args; return result; },
  },
  configurable: true,
});
const repository = path.resolve(import.meta.dirname, "../../../../..");
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    let source: string | undefined;
    if (specifier === "@/lib/ahp/session-evidence") source = `export async function refreshSessionEvidence(...args) { return globalThis["${key}"].refresh(...args); }`;
    if (specifier === "@/lib/ahp/api-error") source = `export function ahpErrorResponse() { return Response.json({error:"failed"}, {status:500}); }`;
    if (source) return { shortCircuit: true, url: `data:text/javascript,${encodeURIComponent(source)}` };
    if (specifier === "next/server") return nextResolve("next/server.js", context);
    if (specifier.startsWith("@/")) return { shortCircuit: true, url: pathToFileURL(path.join(repository, `${specifier.slice(2)}.ts`)).href };
    return nextResolve(specifier, context);
  },
});
after(() => { hooks.deregister(); Reflect.deleteProperty(globalThis, key); });
const { NextRequest } = await import("next/server.js");
const { POST } = await import("./route.ts");
function request(body: string, overrides: Record<string, string> = {}) {
  return new NextRequest("http://127.0.0.1:3000/api/ahp/sessions/evidence", {
    method: "POST",
    headers: {
      host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000",
      "content-type": "application/json", "sec-fetch-site": "same-origin",
      ...overrides,
    },
    body,
  });
}

test("evidence refresh requires a same-origin local deliberate POST", async () => {
  calls = 0;
  const response = await POST(request('{"hostUrl":"ws://fake","sessionUri":"test"}', { origin: "https://other.example" }));
  assert.equal(response.status, 403);
  assert.equal(calls, 0);
});

test("malformed or missing refresh targets fail before any evidence read", async () => {
  calls = 0;
  for (const body of ["{", "null", "{}", '{"hostUrl":" "}', '{"hostUrl":3,"sessionUri":"test"}']) {
    assert.equal((await POST(request(body))).status, 400);
  }
  assert.equal(calls, 0);
});

test("changed, unavailable and superseded captures return conflict rather than current evidence", async () => {
  for (const reason of ["changed", "unavailable", "superseded"] as const) {
    result = { success: false, reason };
    const response = await POST(request('{"hostUrl":"ws://fake","sessionUri":"test"}'));
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), result);
  }
});

test("unsupported capture bounds and total deadlines return explicit structured failures", async () => {
  for (const [reason, detail, status] of [
    ["unsupported", "file-limit", 422],
    ["unsupported", "byte-limit", 422],
    ["unsupported", "changeset-template", 422],
    ["unavailable", "deadline", 503],
  ] as const) {
    result = { success: false, reason, detail };
    const response = await POST(request('{"hostUrl":"ws://fake","sessionUri":"test"}'));
    assert.equal(response.status, status);
    assert.deepEqual(await response.json(), result);
  }
});

test("successful deliberate refresh returns the stored evidence and propagates cancellation", async () => {
  result = {
    success: true,
    session: { resource: "test", provider: "copilotcli", title: "Test", status: 1, createdAt: "", modifiedAt: "" },
    enrichment: { artifacts: [], fileChanges: [], changesetVerified: true, codeFileCount: 0, totalFileCount: 0, additions: 0, deletions: 0 },
  };
  const input = request('{"hostUrl":"ws://fake","sessionUri":"test"}');
  const response = await POST(input);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), result);
  assert.equal(seen![0], "ws://fake");
  assert.equal(seen![1], "test");
  assert.equal(seen![2], input.signal);
});
