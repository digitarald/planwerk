import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Subscription, type AhpClient, type SubscriptionEvent } from "@microsoft/agent-host-protocol/client";
import type { ChatState, ErrorResponsePart, MarkdownResponsePart, SessionSummary, SessionState, Snapshot, StateAction, Turn } from "@microsoft/agent-host-protocol";

import { AHPStatus, type AHPSessionSummary } from "./types.ts";
import type { BridgeEvent } from "./client-bridge.ts";
import type { ChangesetEnrichment } from "./changeset-enricher.ts";
import type { CachedSession } from "../db/session-cache.ts";
import type { Artifact, PendingInput } from "../types.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function stream() {
  const queued: SubscriptionEvent[] = [];
  let waiting: ((event: IteratorResult<SubscriptionEvent>) => void) | undefined;
  let closed = false;
  return {
    push(event: SubscriptionEvent) {
      if (waiting) { const done = waiting; waiting = undefined; done({ done: false, value: event }); }
      else queued.push(event);
    },
    iterator: {
      async next(): Promise<IteratorResult<SubscriptionEvent>> {
        if (closed) return { done: true, value: undefined };
        if (queued.length) return { done: false, value: queued.shift()! };
        return new Promise((done) => { waiting = done; });
      },
      async return() { closed = true; waiting?.({ done: true, value: undefined }); return { done: true as const, value: undefined }; },
      [Symbol.asyncIterator]() { return this; },
    },
  };
}

const tick = async () => {
  for (let i = 0; i < 6; i++) await new Promise<void>((done) => setImmediate(done));
};
const uri = "copilotcli:/test";
const enrichment: ChangesetEnrichment = {
  artifacts: [], fileChanges: [{ path: "a.ts", added: 1, removed: 0 }],
  totalFileCount: 1, codeFileCount: 1, additions: 1, deletions: 0, changesetVerified: true,
};

function harness(status: number = AHPStatus.Idle) {
  const root = stream();
  const reads: string[] = [];
  const releases: string[] = [];
  const shutdowns: string[] = [];
  const emitted: BridgeEvent[] = [];
  const cached = new Map<string, { summary: AHPSessionSummary; enrichment: ChangesetEnrichment | null }>();
  const seededCache: CachedSession[] = [];
  const artifacts: Artifact[] = [];
  const actions: StateAction[] = [];
  let chat: ChatState | undefined;
  const summary: SessionSummary = {
    resource: uri, provider: "copilotcli", title: "Test", status,
    createdAt: "2026-10-15T00:00:00Z", modifiedAt: "2026-10-15T00:00:00Z",
    changes: { files: 1, additions: 1, deletions: 0 },
    chats: [], defaultChat: "ahp-chat:/test",
  };
  const summaries = [summary];
  let readWait: Promise<void> | undefined;
  let connectionWait: Promise<void> | undefined;
  let owned = true;
  const client = {
    async *stateChanges() { yield* []; },
    async request() { return { items: summaries }; },
    attachSubscription() { return new Subscription("ahp-root://", root.iterator); },
    async subscribe(resource: string) {
      reads.push(resource);
      if (readWait) { const wait = readWait; readWait = undefined; await wait; }
      const state = {
        provider: summary.provider, title: summary.title, status: summary.status,
        lifecycle: "ready" as SessionState["lifecycle"], activeClients: [], chats: [],
        config: { schema: { type: "object", properties: {} }, values: { model: "test" } },
        defaultChat: chat?.resource,
      } satisfies SessionState;
      return {
        result: { snapshot: { resource, state: resource === chat?.resource ? chat : state, fromSeq: 0 } satisfies Snapshot },
        subscription: new Subscription(resource, stream().iterator),
      };
    },
    async unsubscribe(resource: string) { releases.push(resource); },
    async shutdown() { shutdowns.push("shutdown"); },
    dispatch(_channel: string, action: StateAction) {
      actions.push(action);
      if (action.type === "chat/turnResume" && chat) chat.turns = [];
    },
    async ping() {},
  };
  return {
    root, client: client as unknown as AhpClient, reads, releases, shutdowns, emitted, cached, summary,
    seededCache, artifacts, actions, summaries, input: undefined as PendingInput | undefined,
    setChat(value: ChatState) { chat = value; },
    ownsSession() { return owned; },
    setOwned(value: boolean) { owned = value; },
    async connect(options?: { initialSubscriptions?: readonly string[] }) {
      if (!options?.initialSubscriptions && connectionWait) { const wait = connectionWait; connectionWait = undefined; await wait; }
      return { client, initialized: { protocolVersion: "1.0.0" }, diagnostics: {} };
    },
    waitForRead(wait: Promise<void>) { readWait = wait; },
    waitForConnection(wait: Promise<void>) { connectionWait = wait; },
    change(changes: Partial<SessionSummary>) {
      Object.assign(summary, changes);
      root.push({ type: "sessionSummaryChanged", params: { channel: "ahp-root://", session: uri, changes } });
    },
  };
}

let active = harness();
const key = "__planwerkBridgeReadTest";
Object.defineProperty(globalThis, key, { get: () => active, configurable: true });
const repository = path.resolve(import.meta.dirname, "../..");
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    let source: string | undefined;
    if (specifier === "server-only") source = "export {}";
    if (specifier === "./endpoint") source = `export async function connectInitializedAhpClient(host, options) {
      return globalThis["${key}"].connect(options);
    }`;
    if (specifier === "@/lib/db/session-cache") source = `
      export const CLEAR_ENRICHMENT = Symbol("clear");
      export function getCachedSessions() { return globalThis["${key}"].seededCache; }
      export function reconcileSessionCache() {}
      export function removeSessionCache(host, uri) { globalThis["${key}"].cached.delete(uri); }
      export function upsertSessionCache(host, uri, summary, enrichment) {
        globalThis["${key}"].cached.set(uri, {summary, enrichment:enrichment === CLEAR_ENRICHMENT ? null : enrichment});
      }`;
    if (specifier === "@/lib/db/schema") source = "export function getDb(){return {};}";
    if (specifier === "@/lib/db/session-ownership") source = `
      export function claimSessionOwnership(){return globalThis["${key}"].ownsSession();}
      export function isSessionOwnedByHost(){return globalThis["${key}"].ownsSession();}`;
    if (specifier === "./changeset-enricher") source = `
      export async function enrichFromChangeset() { return ${JSON.stringify(enrichment)}; }
      export function hashPlanContent(content) { return "plan:" + content; }`;
    if (specifier === "./plan-artifact") source = `
      export async function fetchCopilotCliArtifacts() { return globalThis["${key}"].artifacts; }
      export function clearPlanCache() {}`;
    if (specifier === "./telemetry-logs") source = `
      export function handleOtlpLogs() {}
      export async function rotateLogs() {}`;
    if (specifier === "./telemetry-transport") source = "export class TelemetryTapTransport {}";
    if (specifier === "./rpc-error") source = `
      export function classifyAhpError(error) { return {type:"error", message:String(error)}; }`;
    if (specifier === "./map-session") source = `export function mapSessionInputNeeded() {return globalThis["${key}"].input;}`;
    if (specifier === "@/lib/orchestrator/worker-activity-store") source = `
      export function getWorkerActivityHistory() { return []; }
      export function recordWorkerActivity() {}`;
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
after(() => { hooks.deregister(); Reflect.deleteProperty(globalThis, key); });

const { createAHPBridge } = await import("./client-bridge.ts");
const { invalidateEvidenceReads, publishEvidenceRefresh, publishOwnershipRecovery, bindEnrichment } = await import("./source-binding.ts");
const { readActiveSessionState, readSessionState, withSessionState } = await import("./snapshot.ts");
const { fetchSessionDetails, resumeErroredTurn } = await import("./session-details.ts");
const { injectMessageWithClient } = await import("./session-messenger.ts");

async function start(status: number = AHPStatus.Idle) {
  active = harness(status);
  const dispose = await createAHPBridge({
    hostUrl: "ws://fake",
    onEvent: (event) => active.emitted.push(structuredClone(event)),
  });
  await tick();
  return dispose;
}

test("live initialization includes archived no-change sources in the complete catalog without subscribing", async () => {
  active = harness(AHPStatus.Idle);
  active.summaries.push({
    ...active.summary, resource: "copilotcli:/archived",
    status: AHPStatus.IsArchived | AHPStatus.Idle,
    changes: { files: 0, additions: 0, deletions: 0 },
  });
  const dispose = await createAHPBridge({ hostUrl: "ws://fake", onEvent: (event) => active.emitted.push(structuredClone(event)) });
  await tick();
  const init = active.emitted.find((event) => event.type === "init");
  assert.ok(init?.type === "init");
  assert.equal(init.sessions.length, 1);
  assert.equal(init.catalog?.length, 2);
  assert.equal(init.catalog?.[1].resource, "copilotcli:/archived");
  assert.deepEqual(active.reads, []);
  dispose();
});

test("failed input reads preserve a known question until an authoritative runtime clear", async () => {
  active = harness(AHPStatus.InputNeeded);
  active.input = { requestId: "question", message: "Choose", questions: [] };
  const dispose = await createAHPBridge({ hostUrl: "ws://fake", onEvent: (event) => active.emitted.push(structuredClone(event)) });
  await tick();
  assert.ok(active.emitted.some((event) => event.type === "sessionSummaryChanged" && event.pendingInput?.requestId === "question"));
  active.emitted.length = 0;
  active.client.subscribe = async () => { throw new Error("snapshot unavailable"); };
  active.change({ activity: "Waiting for your choice" });
  await tick();
  assert.equal(active.emitted.some((event) => event.type === "sessionSummaryChanged" && event.pendingInput === null), false);
  active.change({ status: AHPStatus.Idle });
  await tick();
  assert.equal(active.emitted.some((event) => event.type === "sessionSummaryChanged" && event.pendingInput === null), true);
  dispose();
});

test("cold startup, idle timestamps, repeated idle status and cold content events never subscribe", async () => {
  const dispose = await start();
  for (let i = 1; i <= 4; i++) {
    active.change({ modifiedAt: `2026-10-16T10:0${i}:00Z`, status: AHPStatus.Idle });
    await tick();
  }
  active.change({ changes: { files: 2, additions: 2, deletions: 0 } });
  await tick();
  assert.deepEqual(active.reads, []);
  dispose();
});

test("timestamp-only updates invalidate fallback facts without reading even while active", async () => {
  const dispose = await start(AHPStatus.InProgress);
  assert.deepEqual(active.reads, [uri]);
  assert.ok(active.cached.get(uri)?.enrichment);
  active.change({ modifiedAt: "2026-10-16T10:10:00Z" });
  await tick();
  assert.deepEqual(active.reads, [uri]);
  assert.equal(active.cached.get(uri)?.enrichment, null);
  dispose();
});

test("observed active to idle/error permits one completion read, not timestamp feedback", async () => {
  for (const status of [AHPStatus.Idle, AHPStatus.Error]) {
    const dispose = await start(AHPStatus.InProgress);
    active.change({ status, modifiedAt: "2026-10-16T10:10:00Z" });
    await tick();
    assert.equal(active.reads.length, 2);
    assert.ok(active.cached.get(uri)?.enrichment);
    active.change({ modifiedAt: "2026-10-16T10:11:00Z" });
    active.change({ status });
    await tick();
    assert.equal(active.reads.length, 2);
    dispose();
  }
});

test("dirty content work gets one final read on idle, then cannot retry cold", async () => {
  active = harness(AHPStatus.InProgress);
  const wait = deferred<void>();
  active.waitForRead(wait.promise);
  const dispose = await createAHPBridge({ hostUrl: "ws://fake", onEvent: (event) => active.emitted.push(event) });
  await tick();
  active.change({ changes: { files: 2, additions: 2, deletions: 0 } });
  active.change({ status: AHPStatus.Idle, modifiedAt: "2026-10-16T10:10:00Z" });
  await tick();
  wait.resolve();
  await tick();
  assert.equal(active.reads.length, 2);
  active.change({ modifiedAt: "2026-10-16T10:11:00Z" });
  await tick();
  assert.equal(active.reads.length, 2);
  dispose();
});

test("subscribe-induced timestamp cannot dirty-retry itself", async () => {
  active = harness(AHPStatus.InProgress);
  const wait = deferred<void>();
  active.waitForRead(wait.promise);
  const dispose = await createAHPBridge({ hostUrl: "ws://fake", onEvent: () => {} });
  await tick();
  active.change({ modifiedAt: "2026-10-16T10:10:00Z" });
  await tick();
  wait.resolve();
  await tick();
  assert.equal(active.reads.length, 1);
  assert.equal(active.cached.get(uri)?.enrichment, null);
  dispose();
});

test("archiving fences dirty retries and late enrichment; archived startup is passive", async () => {
  active = harness(AHPStatus.InProgress);
  const wait = deferred<void>();
  active.waitForRead(wait.promise);
  const dispose = await createAHPBridge({ hostUrl: "ws://fake", onEvent: () => {} });
  await tick();
  active.change({ changes: { files: 2, additions: 2, deletions: 0 } });
  active.change({ status: AHPStatus.IsArchived | AHPStatus.Idle });
  await tick();
  wait.resolve();
  await tick();
  assert.equal(active.reads.length, 1);
  assert.equal(active.cached.get(uri)?.enrichment, null);
  dispose();
  const stop = await start(AHPStatus.IsArchived | AHPStatus.InProgress);
  assert.deepEqual(active.reads, []);
  stop();
});

test("unchanged archived catalog entries do not rewrite the session cache on reconnect", async () => {
  const status = AHPStatus.IsArchived | AHPStatus.Idle;
  const dispose = await start(status);
  const previous = active.cached.get(uri)!;
  dispose();
  active = harness(status);
  active.seededCache.push({
    sessionUri: uri, ...previous, updatedAt: "2026-10-15T00:00:00Z",
  });
  const stop = await createAHPBridge({ hostUrl: "ws://fake", onEvent: (event) => active.emitted.push(event) });
  await tick();
  assert.deepEqual(active.reads, []);
  assert.equal(active.cached.size, 0, "identical facts must not rotate the cache token or write to SQLite");
  assert.equal(active.emitted.some((event) => event.type === "init" && event.sessions.length === 1), true);
  stop();
});

test("disposal during connection acquisition prevents queued subscriptions and shuts down", async () => {
  active = harness(AHPStatus.InProgress);
  const wait = deferred<void>();
  active.waitForConnection(wait.promise);
  const dispose = await createAHPBridge({ hostUrl: "ws://fake", onEvent: () => {} });
  await tick();
  dispose();
  const coordination = (globalThis as typeof globalThis & {
    __planwerkEvidenceCoordination: { reads: Map<string, symbol>; listeners: Map<string, unknown> };
  }).__planwerkEvidenceCoordination;
  assert.equal(coordination.reads.has(JSON.stringify(["ws://fake", uri])), false);
  assert.equal(coordination.listeners.has("ws://fake"), false);
  wait.resolve();
  await tick();
  assert.deepEqual(active.reads, []);
  assert.ok(active.shutdowns.length >= 2);
});

test("an already-aborted bridge does not retain a refresh listener or start a connection", async () => {
  active = harness();
  const controller = new AbortController();
  controller.abort();
  const stop = await createAHPBridge({ hostUrl: "ws://already-aborted", onEvent: () => {}, signal: controller.signal });
  stop();
  assert.deepEqual(active.reads, []);
  const coordination = (globalThis as typeof globalThis & {
    __planwerkEvidenceCoordination: { listeners: Map<string, unknown> };
  }).__planwerkEvidenceCoordination;
  assert.equal(coordination.listeners.has("ws://already-aborted"), false);
});

test("background snapshot policy defers cold/archived sessions; explicit detail inspection still reads", async () => {
  for (const status of [AHPStatus.Idle, AHPStatus.Error, AHPStatus.IsArchived | AHPStatus.InProgress]) {
    active = harness(status);
    await assert.rejects(readActiveSessionState(active.client, uri), /read deferred/);
    assert.deepEqual(active.reads, []);
  }
  active = harness(AHPStatus.Idle);
  await fetchSessionDetails("ws://fake", uri);
  await readSessionState(active.client, uri);
  assert.deepEqual(active.reads, [uri, uri]);
  assert.deepEqual(active.releases, [uri, uri]);
});

test("dependent reads keep the session subscribed and release on operation failure", async () => {
  active = harness(AHPStatus.InProgress);
  await assert.rejects(withSessionState(active.client, uri, async () => {
    assert.deepEqual(active.releases, []);
    throw new Error("detail failed");
  }), /detail failed/);
  assert.deepEqual(active.releases, [uri]);
});

test("an explicit refresh supersedes older bridge work and adopted evidence survives later summaries", async () => {
  active = harness(AHPStatus.InProgress);
  const wait = deferred<void>();
  active.waitForRead(wait.promise);
  const dispose = await createAHPBridge({ hostUrl: "ws://fake", onEvent: (event) => active.emitted.push(event) });
  await tick();
  invalidateEvidenceReads("ws://fake", uri);
  const summary = active.cached.get(uri)!.summary;
  const refreshed = bindEnrichment(summary, { ...enrichment, capturedFilesDigest: "captured-explicit" });
  publishEvidenceRefresh("ws://fake", { session: summary, enrichment: refreshed });
  wait.resolve();
  await tick();
  const update = active.emitted.filter((event) => event.type === "sessionSummaryChanged").at(-1);
  assert.equal(update?.type === "sessionSummaryChanged" ? update.enrichment : undefined, refreshed);
  active.change({ title: "Updated title" });
  await tick();
  assert.equal(active.cached.get(uri)?.enrichment?.capturedFilesDigest, "captured-explicit");
  const readsBeforeTimestamp = active.reads.length;
  active.change({ modifiedAt: "2026-10-17T10:10:00Z" });
  await tick();
  assert.equal(active.cached.get(uri)?.enrichment, null);
  const persisted = active.cached.get(uri)?.summary as { _planwerkRiskFacts?: { evidenceDigest?: string } };
  assert.equal(persisted._planwerkRiskFacts?.evidenceDigest, undefined);
  assert.equal(active.reads.length, readsBeforeTimestamp, "timestamp invalidation cannot authorize a new subscription");
  dispose();
});

test("URI ownership collisions retain a display-only catalog entry without live reads", async () => {
  active = harness(AHPStatus.InProgress);
  active.summary.chats = [{ resource: "ahp-chat:/conflicted", title: "Conflicted", status: AHPStatus.InProgress }];
  active.summary.defaultChat = "ahp-chat:/conflicted";
  active.setOwned(false);
  const dispose = await createAHPBridge({ hostUrl: "ws://fake", onEvent: (event) => active.emitted.push(event) });
  await tick();
  const init = active.emitted.find((event) => event.type === "init");
  assert.equal(init?.type === "init" ? init.sessions.length : -1, 1);
  assert.deepEqual(active.reads, []);
  assert.equal(active.cached.size, 0);
  assert.equal(active.shutdowns.length, 0, "a conflicting URI must not terminate the host");
  dispose();
});

test("explicit ownership recovery updates passive conflict entries without restoring the session", async () => {
  active = harness(AHPStatus.Idle);
  active.setOwned(false);
  const dispose = await createAHPBridge({ hostUrl: "ws://fake", onEvent: (event) => active.emitted.push(event) });
  await tick();
  active.setOwned(true);
  publishOwnershipRecovery(["ws://fake", "ws://other"], {
    session: {
      resource: uri, provider: "copilotcli", title: "Selected host", status: AHPStatus.Idle,
      createdAt: "2026-10-15T00:00:00Z", modifiedAt: "2026-10-15T00:00:00Z",
    },
    selectedHostUrl: "ws://fake", revision: 2,
  });
  const update = active.emitted.at(-1);
  assert.equal(update?.type, "sessionSummaryChanged");
  if (update?.type === "sessionSummaryChanged") {
    assert.equal(update.session.title, "Selected host");
    assert.equal(update.enrichment, null);
  }
  assert.deepEqual(active.reads, []);
  dispose();
});

test("quarantine suppresses late enrichment but retains a passive recovery entry", async () => {
  active = harness(AHPStatus.InProgress);
  const wait = deferred<void>();
  active.waitForRead(wait.promise);
  const dispose = await createAHPBridge({ hostUrl: "ws://fake", onEvent: (event) => active.emitted.push(event) });
  await tick();
  const emittedBefore = active.emitted.length;
  active.setOwned(false);
  active.change({ changes: { files: 2, additions: 2, deletions: 0 } });
  await tick();
  wait.resolve();
  await tick();
  const later = active.emitted.slice(emittedBefore);
  assert.equal(later.some((event) => event.type === "sessionSummaryChanged" && event.enrichment), false);
  assert.equal(later.some((event) => event.type === "sessionSummaryChanged" && event.enrichment === null), true);
  assert.equal(later.some((event) => event.type === "sessionRemoved"), false);
  assert.equal(active.cached.get(uri)?.enrichment, null);
  dispose();
});

function completedChat(): ChatState {
  return {
    resource: "ahp-chat:/test", title: "Test", status: AHPStatus.Idle,
    modifiedAt: "2026-10-16T10:10:00Z",
    turns: [{
      id: "turn-1", message: { text: "Research", origin: { kind: "user" as Turn["message"]["origin"]["kind"] } },
      state: "complete" as Turn["state"], usage: undefined,
      responseParts: [{ kind: "markdown" as MarkdownResponsePart["kind"], id: "response-1", content: "Research complete." }],
    }],
  };
}

test("zero-file completion still captures the final assistant outcome", async () => {
  active = harness(AHPStatus.InProgress);
  active.summary.changes = { files: 0, additions: 0, deletions: 0 };
  active.setChat(completedChat());
  const dispose = await createAHPBridge({ hostUrl: "ws://fake", onEvent: () => {} });
  await tick();
  active.change({ status: AHPStatus.Idle, modifiedAt: "2026-10-16T10:10:00Z" });
  await tick();
  assert.equal(active.cached.get(uri)?.enrichment?.lastAgentMessage, "Research complete.");
  assert.equal(active.reads.filter((resource) => resource === uri).length, 2);
  dispose();
});

test("cold startup clears timestamp-stale cached plan and files without fetching", async () => {
  active = harness(AHPStatus.InProgress);
  active.artifacts.push({
    id: "plan", type: "plan", title: "Plan", contentRef: "Do work",
    createdAt: 0, createdBy: "agent", status: "draft",
  });
  const dispose = await createAHPBridge({ hostUrl: "ws://fake", onEvent: () => {} });
  await tick();
  const cached = active.cached.get(uri)!;
  assert.equal(cached.enrichment?.planContentHash, "plan:Do work");
  dispose();
  active = harness(AHPStatus.Idle);
  active.summary.modifiedAt = "2026-10-16T10:11:00Z";
  active.seededCache.push({
    sessionUri: uri, summary: { ...cached.summary, status: AHPStatus.Idle },
    enrichment: cached.enrichment, updatedAt: "2026-10-15T00:00:00Z",
  });
  const stop = await createAHPBridge({ hostUrl: "ws://fake", onEvent: () => {} });
  await tick();
  assert.deepEqual(active.reads, []);
  assert.equal(active.cached.get(uri)?.enrichment, null);
  stop();
});

test("explicit content revisions refresh active facts but never authorize a cold read", async () => {
  const dispose = await start(AHPStatus.InProgress);
  active.artifacts.push({
    id: "plan", type: "plan", title: "Plan", contentRef: "Do work",
    createdAt: 0, createdBy: "agent", status: "draft",
  });
  active.change({ _meta: { contentRevision: "v2" } });
  await tick();
  assert.equal(active.reads.length, 2);
  assert.equal(active.cached.get(uri)?.enrichment?.planContentHash, "plan:Do work");
  active.change({ modifiedAt: "2026-10-16T10:10:00Z" });
  await tick();
  assert.equal(active.reads.length, 2);
  assert.equal(active.cached.get(uri)?.enrichment, null, "plan freshness is unknown after timestamp churn");
  active.change({ status: AHPStatus.Idle });
  await tick();
  const reads = active.reads.length;
  active.change({ _meta: { contentRevision: "v3" } });
  await tick();
  assert.equal(active.reads.length, reads);
  assert.equal(active.cached.get(uri)?.enrichment, null);
  dispose();
});

test("explicit sending and verified turn resume remain available for cold sessions", async () => {
  active = harness(AHPStatus.Idle);
  active.setChat(completedChat());
  const sent = await injectMessageWithClient(active.client, uri, "Continue");
  assert.equal(sent.success, true);
  assert.equal(active.actions.at(-1)?.type, "chat/turnStarted");

  const errored = completedChat();
  errored.turns[0].state = "error" as Turn["state"];
  errored.turns[0].responseParts = [{
    kind: "error" as ErrorResponsePart["kind"], resumable: true,
    error: { errorType: "test", message: "Try again" },
  }];
  active.setChat(errored);
  const before = active.actions.length;
  const stale = await resumeErroredTurn("ws://fake", uri, errored.resource, "wrong-turn");
  assert.equal(stale.success, false);
  assert.equal(active.actions.length, before);
  const resumed = await resumeErroredTurn("ws://fake", uri, errored.resource, "turn-1");
  assert.equal(resumed.success, true);
  assert.equal(active.actions.at(-1)?.type, "chat/turnResume");
});

test("a stable host code revision cannot rebind an in-flight plan across timestamp drift", async () => {
  active = harness(AHPStatus.InProgress);
  active.summary._meta = { contentRevision: "v1" };
  active.artifacts.push({
    id: "plan", type: "plan", title: "Plan", contentRef: "Old plan",
    createdAt: 0, createdBy: "agent", status: "draft",
  });
  const wait = deferred<void>();
  active.waitForRead(wait.promise);
  const dispose = await createAHPBridge({ hostUrl: "ws://fake", onEvent: () => {} });
  await tick();
  active.change({ modifiedAt: "2026-10-16T10:10:00Z" });
  await tick();
  wait.resolve();
  await tick();
  assert.equal(active.reads.length, 1);
  assert.equal(active.cached.get(uri)?.enrichment, null);
  dispose();
});

test("idle transition fences an older snapshot even without a timestamp or count change", async () => {
  active = harness(AHPStatus.InProgress);
  const wait = deferred<void>();
  active.waitForRead(wait.promise);
  const published: BridgeEvent[] = [];
  const dispose = await createAHPBridge({ hostUrl: "ws://fake", onEvent: (event) => published.push(event) });
  await tick();
  active.change({ status: AHPStatus.Idle });
  await tick();
  wait.resolve();
  await tick();
  assert.equal(active.reads.length, 2);
  assert.equal(published.filter((event) => event.type === "sessionSummaryChanged" && event.enrichment).length, 1);
  dispose();
});

test("archiving during connection acquisition fences a queued live read", async () => {
  active = harness(AHPStatus.InProgress);
  const wait = deferred<void>();
  active.waitForConnection(wait.promise);
  const dispose = await createAHPBridge({ hostUrl: "ws://fake", onEvent: () => {} });
  await tick();
  active.change({ status: AHPStatus.IsArchived | AHPStatus.Idle });
  await tick();
  wait.resolve();
  await tick();
  assert.deepEqual(active.reads, []);
  assert.equal(active.cached.get(uri)?.enrichment, null);
  dispose();
});

test("failed reads leave unknown facts without a retry loop; explicit errors and aborts propagate", async () => {
  active = harness(AHPStatus.InProgress);
  let attempts = 0;
  active.client.subscribe = async () => {
    attempts++;
    throw new Error("snapshot unavailable");
  };
  const dispose = await createAHPBridge({ hostUrl: "ws://fake", onEvent: () => {} });
  await tick();
  assert.equal(attempts, 1);
  assert.equal(active.cached.get(uri)?.enrichment, null);
  await assert.rejects(fetchSessionDetails("ws://fake", uri), /snapshot unavailable/);
  assert.equal(attempts, 2);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(fetchSessionDetails("ws://fake", uri, controller.signal), { name: "AbortError" });
  assert.equal(attempts, 2);
  assert.equal(active.shutdowns.length, 2);
  dispose();
});
