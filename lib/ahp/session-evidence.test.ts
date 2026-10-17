import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Subscription, type AhpClient, type SubscriptionEvent } from "@microsoft/agent-host-protocol/client";
import type { ChangesetContentChangedAction, ChangesetFile, ChatState, SessionState, SessionSummary, SessionTitleChangedAction, Snapshot } from "@microsoft/agent-host-protocol";

import type { AHPSessionSummary } from "./types.ts";
import type { ChangesetEnrichment } from "./changeset-enricher.ts";
import { mapSdkSessionSummary } from "./session-summary.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
function stream() {
  const queue: SubscriptionEvent[] = [];
  let waiting: ((value: IteratorResult<SubscriptionEvent>) => void) | undefined;
  let ended = false;
  return {
    end() { ended = true; waiting?.({ done: true, value: undefined }); },
    push(value: SubscriptionEvent) {
      if (waiting) { const done = waiting; waiting = undefined; done({ done: false, value }); }
      else queue.push(value);
    },
    iterator: {
      async next(): Promise<IteratorResult<SubscriptionEvent>> {
        if (ended) return { done: true, value: undefined };
        if (queue.length) return { done: false, value: queue.shift()! };
        return new Promise((done) => { waiting = done; });
      },
      async return() { ended = true; waiting?.({ done: true, value: undefined }); return { done: true as const, value: undefined }; },
      [Symbol.asyncIterator]() { return this; },
    },
  };
}
const uri = "copilotcli:/test";
const chatUri = "ahp-chat:/test";
const changesetUri = "ahp-changeset:/test";
const host = "ws://fake";
function harness() {
  const summary: SessionSummary = {
    resource: uri, provider: "copilotcli", title: "Test", status: 1,
    createdAt: "2026-10-17T00:00:00Z", modifiedAt: "2026-10-17T00:00:00Z",
    changes: { files: 2, additions: 2, deletions: 1 },
  };
  const files: ChangesetFile[] = [{
    id: "code",
    edit: {
      before: { uri: "file:///a.ts", content: { uri: "ahp-content:/old" } },
      after: { uri: "file:///a.ts", content: { uri: "ahp-content:/new" } },
      diff: { added: 1, removed: 1 },
    },
  }, {
    id: "plan",
    edit: {
      after: { uri: "file:///plan.md", content: { uri: "ahp-content:/plan" } },
      diff: { added: 1, removed: 0 },
    },
  }];
  const session: SessionState = {
    provider: "copilotcli", title: "Test", status: 1, lifecycle: "ready" as SessionState["lifecycle"],
    activeClients: [], chats: [], defaultChat: chatUri,
    changesets: [{ changeKind: "session", label: "Session", uriTemplate: changesetUri }],
    config: { schema: { type: "object", properties: {} }, values: { model: "test" } },
  };
  const chat = { resource: chatUri, turns: [] } as unknown as ChatState;
  const subscriptions: string[] = [];
  const releases: string[] = [];
  const streams = new Map<string, ReturnType<typeof stream>>();
  const resources = new Map([["ahp-content:/old", "old"], ["ahp-content:/new", "new"], ["ahp-content:/plan", "# Plan"]]);
  let cache: { summary: AHPSessionSummary; enrichment: ChangesetEnrichment | null; cacheToken: string } | null = {
    summary: mapSdkSessionSummary(summary), enrichment: null, cacheToken: "0",
  };
  let token = 0;
  let connections = 0;
  let shutdowns = 0;
  let resourceReads = 0;
  let nextRead: (() => Promise<void>) | undefined;
  let connectionWait: Promise<void> | undefined;
  return {
    summary, files, session, streams, resources, subscriptions, releases,
    get cache() { return cache; },
    get connections() { return connections; },
    get shutdowns() { return shutdowns; },
    get resourceReads() { return resourceReads; },
    snapshot(requestedHost: string) {
      return requestedHost === host && cache ? { sessionUri: uri, updatedAt: "", ...structuredClone(cache) } : null;
    },
    cas(requestedHost: string, expected: string, nextSummary: AHPSessionSummary, enrichment: ChangesetEnrichment | null) {
      if (requestedHost !== host || !cache || cache.cacheToken !== expected) return false;
      cache = { summary: structuredClone(nextSummary), enrichment: structuredClone(enrichment), cacheToken: String(++token) };
      return true;
    },
    overwrite() { if (cache) cache.cacheToken = String(++token); },
    remove() { cache = null; },
    blockRead(action: () => Promise<void>) { nextRead = action; },
    blockConnection(wait: Promise<void>) { connectionWait = wait; },
    async connect() {
      connections++;
      if (connectionWait) await connectionWait;
      const released = new Set<string>();
      return {
        client: {
          async request(method: string, params: { uri?: string }) {
            if (method === "listSessions") return { items: [structuredClone(summary)] };
            resourceReads++;
            if (nextRead) { const action = nextRead; nextRead = undefined; await action(); }
            assert.equal(released.has(uri), false, "session residency retained through resource reads");
            assert.equal(released.has(chatUri), false, "chat stream retained through resource reads");
            const data = resources.get(params.uri!);
            if (data === undefined) throw new Error("missing content");
            return { data: Buffer.from(data).toString("base64"), encoding: "base64" };
          },
          async subscribe(resource: string) {
            subscriptions.push(resource);
            const source = stream();
            streams.set(resource, source);
            const state = resource === uri ? session : resource === chatUri ? chat : { status: "ready", files };
            return {
              result: { snapshot: { resource, state: structuredClone(state), fromSeq: 0 } as Snapshot },
              subscription: new Subscription(resource, source.iterator),
            };
          },
          async unsubscribe(resource: string) { releases.push(resource); released.add(resource); },
          async shutdown() { shutdowns++; },
        } as unknown as AhpClient,
      };
    },
  };
}
let active = harness();
const key = "__planwerkSessionEvidenceTest";
Object.defineProperty(globalThis, key, { get: () => active, configurable: true });
const repository = path.resolve(import.meta.dirname, "../..");
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    let source: string | undefined;
    if (specifier === "server-only") source = "export {}";
    if (specifier === "./endpoint") source = `export async function connectInitializedAhpClient() { return globalThis["${key}"].connect(); }`;
    if (specifier === "../db/session-cache") source = `
      export function getSessionCacheSnapshot(host) { return globalThis["${key}"].snapshot(host); }
      export function compareAndSwapSessionCache(host,uri,token,summary,enrichment) { return globalThis["${key}"].cas(host,token,summary,enrichment); }`;
    if (specifier === "./map-session") source = "export function mapSessionInputNeeded() {}";
    if (source) return { shortCircuit: true, url: `data:text/javascript,${encodeURIComponent(source)}` };
    if (specifier.startsWith("@/")) return { shortCircuit: true, url: pathToFileURL(path.join(repository, `${specifier.slice(2)}.ts`)).href };
    if (specifier.startsWith(".") && !path.extname(specifier) && context.parentURL?.startsWith("file:")) {
      const candidate = fileURLToPath(new URL(`${specifier}.ts`, context.parentURL));
      if (existsSync(candidate)) return { shortCircuit: true, url: pathToFileURL(candidate).href };
    }
    return nextResolve(specifier, context);
  },
});
after(() => { hooks.deregister(); Reflect.deleteProperty(globalThis, key); });
const { refreshSessionEvidence } = await import("./session-evidence.ts");
const { invalidateEvidenceReads, observeEvidenceRefresh } = await import("./source-binding.ts");

test("deliberate full refresh owns one session subscription through chat, changeset and byte reads", async () => {
  active = harness();
  const updates: Array<ChangesetEnrichment | null> = [];
  const stop = observeEvidenceRefresh(host, (update) => updates.push(update.enrichment));
  const result = await refreshSessionEvidence(host, uri);
  stop();
  assert.equal(result.success, true);
  assert.deepEqual(active.subscriptions, [uri, chatUri, changesetUri]);
  assert.deepEqual(active.releases, [changesetUri, chatUri, uri]);
  assert.equal(active.shutdowns, 1);
  assert.equal(active.cache?.enrichment?.planContent, "# Plan");
  const binding = (active.cache?.summary as { _planwerkRiskFacts?: { evidenceDigest?: string } })._planwerkRiskFacts;
  assert.match(binding?.evidenceDigest ?? "", /^[a-f0-9]{64}$/);
  assert.equal(updates.length, 2);
  assert.equal(updates[0], null);
});

test("unknown or wrong-host sessions cannot open a connection", async () => {
  active = harness();
  assert.deepEqual(await refreshSessionEvidence("ws://other", uri), { success: false, reason: "unavailable" });
  assert.equal(active.connections, 0);
});

test("a catalog revision changing during capture cannot become current", async () => {
  active = harness();
  const gate = deferred();
  const started = deferred();
  active.blockRead(async () => { started.resolve(); await gate.promise; });
  const pending = refreshSessionEvidence(host, uri);
  await started.promise;
  active.summary.modifiedAt = "2026-10-17T00:00:01Z";
  gate.resolve();
  assert.deepEqual(await pending, { success: false, reason: "changed" });
  assert.equal(active.cache?.enrichment, null);
});

test("resource byte changes between two full captures are rejected without a catalog revision", async () => {
  active = harness();
  const previous = active.resources.get.bind(active.resources);
  let newReads = 0;
  active.resources.get = (key: string) => {
    if (key === "ahp-content:/new") return ++newReads === 1 ? "new" : "NEW";
    return previous(key);
  };
  assert.deepEqual(await refreshSessionEvidence(host, uri), { success: false, reason: "changed" });
  assert.equal(active.cache?.enrichment, null);
});

test("a newer refresh supersedes an older in-flight capture", async () => {
  active = harness();
  const gate = deferred();
  const started = deferred();
  active.blockRead(async () => { started.resolve(); await gate.promise; });
  const first = refreshSessionEvidence(host, uri);
  await started.promise;
  assert.equal((await refreshSessionEvidence(host, uri)).success, true);
  const stored = structuredClone(active.cache);
  gate.resolve();
  assert.deepEqual(await first, { success: false, reason: "superseded" });
  assert.deepEqual(active.cache, stored);
});

test("newer bridge/cache work and disposal invalidate an in-flight capture", async () => {
  for (const invalidate of [() => active.overwrite(), () => invalidateEvidenceReads(host, uri)]) {
    active = harness();
    const gate = deferred();
    const started = deferred();
    active.blockRead(async () => { started.resolve(); await gate.promise; });
    const pending = refreshSessionEvidence(host, uri);
    await started.promise;
    invalidate();
    gate.resolve();
    assert.deepEqual(await pending, { success: false, reason: "superseded" });
    assert.equal(active.cache?.enrichment, null);
  }
});

test("interrupted streams and cancelled requests never persist captured evidence", async () => {
  active = harness();
  active.blockRead(async () => { active.streams.get(changesetUri)!.end(); });
  await assert.rejects(refreshSessionEvidence(host, uri), /state stream ended/);
  assert.equal(active.cache?.enrichment, null);
  active = harness();
  const controller = new AbortController();
  active.blockRead(async () => { controller.abort(); });
  await assert.rejects(refreshSessionEvidence(host, uri, controller.signal), { name: "AbortError" });
  assert.equal(active.cache?.enrichment, null);
});

test("changeset and session actions observed during capture cannot be rebound", async () => {
  for (const channel of [changesetUri, uri]) {
    active = harness();
    active.blockRead(async () => {
      active.streams.get(channel)!.push({
        type: "action", params: {
          channel, serverSeq: 1, origin: undefined,
          action: channel === changesetUri
            ? { type: "changeset/contentChanged" as ChangesetContentChangedAction["type"], files: [] }
            : { type: "session/titleChanged" as SessionTitleChangedAction["type"], title: "Changed" },
        },
      });
    });
    assert.deepEqual(await refreshSessionEvidence(host, uri), { success: false, reason: "changed" });
    assert.equal(active.cache?.enrichment, null);
  }
});

test("a missing file-side resource never becomes a verified empty changeset", async () => {
  active = harness();
  active.resources.delete("ahp-content:/old");
  await assert.rejects(refreshSessionEvidence(host, uri), /missing content/);
  assert.equal(active.cache?.enrichment, null);
});

test("full captures reject unsupported file counts before resource reads", async () => {
  active = harness();
  const result = await refreshSessionEvidence(host, uri, undefined, { maxFiles: 1, maxDecodedBytes: 100, timeoutMs: 1_000 });
  assert.deepEqual(result, { success: false, reason: "unsupported", detail: "file-limit" });
  assert.equal(active.resourceReads, 0);
  assert.equal(active.cache?.enrichment, null);
});

test("decoded byte limits span both captures and never persist a partial digest", async () => {
  active = harness();
  const result = await refreshSessionEvidence(host, uri, undefined, { maxFiles: 3, maxDecodedBytes: 20, timeoutMs: 1_000 });
  assert.deepEqual(result, { success: false, reason: "unsupported", detail: "byte-limit" });
  assert.equal(active.resourceReads, 6);
  assert.equal(active.cache?.enrichment, null);
});

test("the total deadline bounds connection acquisition and resource capture without late persistence", async () => {
  for (const phase of ["connection", "resource"]) {
    active = harness();
    const gate = deferred();
    if (phase === "connection") active.blockConnection(gate.promise);
    else active.blockRead(() => gate.promise);
    const result = await refreshSessionEvidence(host, uri, undefined, {
      maxFiles: 3, maxDecodedBytes: 100, timeoutMs: 10,
    });
    assert.deepEqual(result, { success: false, reason: "unavailable", detail: "deadline" });
    assert.equal(active.cache?.enrichment, null);
    gate.resolve();
    for (let i = 0; i < 6; i++) await new Promise<void>((done) => setImmediate(done));
    assert.equal(active.cache?.enrichment, null);
  }
});
