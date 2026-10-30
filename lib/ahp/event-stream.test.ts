import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import type { AHPBridgeOptions, BridgeEvent } from "./client-bridge.ts";
import type { HeartbeatHostSnapshot } from "../orchestrator/heartbeat.ts";
import type { NextRequest } from "next/server";
import { inboxEvents } from "../inbox/events.ts";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const state: {
  bridge?: AHPBridgeOptions;
  getHosts?: () => HeartbeatHostSnapshot[];
  heartbeat: boolean;
  failProjection: boolean;
  triageWait?: Promise<void>;
  triages: number;
  triageError?: Error;
  riskStatus: string;
  sessions: Map<string, object>;
  projections: string[];
  bridges: number;
  archiveCompletions: number;
  reconciliations: Array<{ host: string; catalog: Array<{ enabled: boolean; session: { resource: string } }>; cardId?: string }>;
} = { heartbeat: false, failProjection: false, triages: 0, riskStatus: "current", sessions: new Map(), projections: [], bridges: 0, archiveCompletions: 0, reconciliations: [] };
const key = "__planwerkEventStreamTest";
Object.defineProperty(globalThis, key, { value: state, configurable: true });
const root = path.resolve(import.meta.dirname, "../..");
const routeUrl = pathToFileURL(path.join(root, "app/api/ahp/events/route.ts")).href;
const mocks: Record<string, string> = {
  "next/server": `export class NextResponse extends Response { static json(value, init) { return new Response(JSON.stringify(value), init); } }`,
  "@/lib/ahp/client-bridge": `export async function createAHPBridge(options) { globalThis["${key}"].bridge = options; globalThis["${key}"].bridges++; }`,
  "@/lib/ahp/enrich-card": `export function enrichSessionToCard(s) { globalThis["${key}"].projections.push(s.resource); globalThis["${key}"].sessions.set(s.resource, structuredClone(s)); return { id:s.resource, title:s.title, isArchived:!!(s.status & 64), workingDirectory:s.workingDirectory, phase:"plan", runtime:s.status === 24 ? "input-needed" : s.status === 8 ? "running" : "idle", risk:"medium" }; }`,
  "@/lib/ahp/map-session": `export function mapSessionToCard(s) { return {id:s.resource}; }`,
  "@/lib/ahp/connection-error": `export function classifyError(message) { return {type:"error",message}; }`,
  "@/lib/db/session-cache": `export function getCachedSessions() { return [{summary:{resource:"cached",title:"Cached",status:1}}, ...[...globalThis["${key}"].sessions.values()].map(summary=>({summary}))]; } export function getCachedSession(host,id) {const summary=globalThis["${key}"].sessions.get(id);return summary ? {summary} : undefined;}`,
  "@/lib/orchestrator/triage": `export async function triageCard() { const s=globalThis["${key}"];s.triages++;await s.triageWait;if(s.triageError)throw s.triageError;return {risk:{level:"medium",factors:[]},requiredGates:[],requiresHumanApproval:false}; }`,
  "@/lib/orchestrator/gate-engine": `export function getPersistedCardPhase() { if(globalThis["${key}"].failProjection) throw new Error("projection failed"); return "plan"; }`,
  "@/lib/orchestrator/risk-store": `export function getAuthoritativeCardRisk() { return {status:globalThis["${key}"].riskStatus}; } export function getAuthoritativeRiskSnapshot(host,id) { return {digest:"facts:"+id,hostUrl:host,cardId:id}; }`,
  "@/lib/orchestrator/heartbeat": `export function requestHeartbeatTick() {} export function invalidateHostWork() {} export function startHeartbeat(getHosts) { const s=globalThis["${key}"]; s.getHosts=getHosts; s.heartbeat=true; } export async function stopHeartbeat() { globalThis["${key}"].heartbeat=false; } export function isHeartbeatRunning() { return globalThis["${key}"].heartbeat; }`,
  "@/lib/http/local-mutation": `export function validateLocalEventStreamRequest() {}`,
  "@/lib/inbox/service": `export function projectArchivedSessionToInbox() { globalThis["${key}"].archiveCompletions++; } export function projectCardToInbox() {} export function projectHeartbeatToInbox() {} export function projectRemovedSessionToInbox() {} export function reconcileInboxCatalogToInbox(host,catalog,cardId) {globalThis["${key}"].reconciliations.push({host,catalog,cardId});}`,
  "@/lib/desktop/status": `export function registerDesktopHosts() {}`,
};
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (mocks[specifier]) return { shortCircuit: true, url: `data:text/javascript,${encodeURIComponent(mocks[specifier])}` };
    if (specifier.startsWith("@/")) return { shortCircuit: true, url: pathToFileURL(path.join(root, `${specifier.slice(2)}.ts`)).href };
    if (specifier.startsWith(".") && !path.extname(specifier) && context.parentURL?.startsWith("file:")) {
      const candidate = fileURLToPath(new URL(`${specifier}.ts`, context.parentURL));
      if (existsSync(candidate)) return { shortCircuit: true, url: pathToFileURL(candidate).href };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === routeUrl) return {
      shortCircuit: true, format: "module",
      source: ts.transpileModule(readFileSync(fileURLToPath(url), "utf8"), {
        compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
      }).outputText,
    };
    return nextLoad(url, context);
  },
});
after(() => { hooks.deregister(); Reflect.deleteProperty(globalThis, key); });
const { GET } = await import("../../app/api/ahp/events/route.ts");
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
async function open(host = "ws://fake", archivedOnly = false, scope?: string[]) {
  const request = { nextUrl: new URL(`http://localhost/api/ahp/events?host=${encodeURIComponent(host)}${archivedOnly ? "&view=archived" : ""}${scope ? `&workspaceScope=${encodeURIComponent(JSON.stringify(scope))}` : ""}`) };
  const response = await GET(request as NextRequest);
  return response.body!.getReader();
}
function emit(event: BridgeEvent) { state.bridge!.onEvent(event); }

test("cached initialization is display-only until live init; queued events retain their snapshots", async () => {
  const before = state.reconciliations.length;
  const reader = await open();
  await reader.read();
  assert.equal(state.reconciliations.length, before);
  assert.deepEqual(state.getHosts!(), []);
  emit({ type: "init", sessions: [], catalog: [], enrichments: new Map(), pendingInputs: new Map(), workers: new Map(), connection: {
    logicalUrl: "ws://fake", transport: "websocket", resolvedTarget: "ws://fake",
    candidateCount: 1, compatibleCandidateCount: 1, protocolVersion: "1.0.0",
    totalSessions: 0, visibleSessions: 0, filteredSessions: 0,
  } });
  await reader.read();
  assert.equal(state.reconciliations.length, before + 1);
  assert.equal(state.getHosts!().length, 1);
  const session = { resource: "burst", title: "Burst", status: 1, provider: "fake", createdAt: "", modifiedAt: "" };
  emit({ type: "sessionAdded", session });
  session.status = 8;
  emit({ type: "sessionSummaryChanged", session });
  const first = JSON.parse(new TextDecoder().decode((await reader.read()).value).slice(6));
  const second = JSON.parse(new TextDecoder().decode((await reader.read()).value).slice(6));
  assert.equal(first.card.runtime, "idle");
  assert.equal(second.card.runtime, "running");
  await reader.cancel();
  assert.equal(state.bridge!.signal!.aborted, true);
});

test("disabled folders are absent from cache, live snapshots, updates, and automation", async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "planwerk-hidden-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(path.join(directory, ".github"));
  const file = path.join(directory, ".github", "planwerk.yml");
  writeFileSync(file, "enabled: false\n");
  const session = {
    resource: "hidden-notes", title: "Notes", provider: "fake", status: 1,
    createdAt: "", modifiedAt: "", workingDirectory: directory,
  };
  state.sessions.set(session.resource, session);
  t.after(() => state.sessions.delete(session.resource));
  const reader = await open("ws://hidden-notes");
  const decode = (value?: Uint8Array) => JSON.parse(new TextDecoder().decode(value).slice(6));
  const cached = decode((await reader.read()).value);
  assert.equal(cached.cards.some((card: { id: string }) => card.id === session.resource), false);
  emit({
    type: "init", sessions: [session], catalog: [session], enrichments: new Map(), pendingInputs: new Map(), workers: new Map(),
    connection: {
      logicalUrl: "ws://hidden-notes", transport: "websocket", resolvedTarget: "ws://hidden-notes",
      candidateCount: 1, compatibleCandidateCount: 1, protocolVersion: "1.0.0",
      totalSessions: 1, visibleSessions: 1, filteredSessions: 0,
    },
  });
  const live = decode((await reader.read()).value);
  assert.deepEqual(live.cards, []);
  assert.equal(live.connection.filteredSessions, 1);
  assert.equal(state.reconciliations.at(-1)?.catalog[0].enabled, false);
  state.riskStatus = "missing";
  t.after(() => { state.riskStatus = "current"; });
  const before = state.triages;
  emit({ type: "sessionAdded", session });
  assert.equal(decode((await reader.read()).value).type, "cardRemoved");
  assert.equal(state.reconciliations.at(-1)?.cardId, session.resource);
  await tick();
  assert.equal(state.triages, before);
  assert.deepEqual(state.getHosts!()[0].cards, []);
  state.riskStatus = "current";
  writeFileSync(file, "enabled: true\n");
  emit({ type: "sessionSummaryChanged", session });
  assert.equal(decode((await reader.read()).value).card.id, session.resource);
  writeFileSync(file, "enabled: false\n");
  assert.deepEqual(state.getHosts!()[0].cards, []);
  emit({ type: "sessionSummaryChanged", session });
  assert.equal(decode((await reader.read()).value).type, "cardRemoved");
  await reader.cancel();
});
test("producer closure removes inbox listeners, closes host and fences replayed cache", async () => {
  const reader = await open();
  await reader.read();
  emit({ type: "error", code: "unknown", message: "lost", hint: "" });
  await reader.read();
  assert.equal((await reader.read()).done, true);
  assert.deepEqual(state.getHosts!(), []);
  const original = console.error;
  const errors: unknown[] = [];
  console.error = (...args) => errors.push(args);
  try {
    inboxEvents.publish({ type: "inboxRemoved", itemId: "fake", workflowState: "resolved", hostUrl: "ws://fake" });
    assert.deepEqual(errors, []);
  } finally { console.error = original; }
  const replacement = await open();
  await replacement.read();
  assert.deepEqual(state.getHosts!(), []);
  await replacement.cancel();
  await tick();
});

test("blocked model work does not delay deterministic events or revive a removed card", async () => {
  let finish!: () => void;
  state.triageWait = new Promise<void>((resolve) => { finish = resolve; });
  state.riskStatus = "missing";
  const reader = await open();
  await reader.read();
  const session = { resource: "slow-model", title: "Slow", status: 1, provider: "fake", createdAt: "", modifiedAt: "" };
  emit({ type: "sessionAdded", session });
  await reader.read();
  await tick();
  assert.ok(state.triages > 0);
  emit({ type: "sessionSummaryChanged", session: { ...session, status: 8 } });
  const running = JSON.parse(new TextDecoder().decode((await reader.read()).value).slice(6));
  assert.equal(running.card.runtime, "running");
  emit({ type: "sessionRemoved", resource: session.resource });
  await reader.read();
  finish();
  await tick();
  assert.equal(state.getHosts!().some((host) => host.cards.some((card) => card.id === session.resource)), false);
  await reader.cancel();
  state.riskStatus = "current";
  state.triageWait = undefined;
});

test("1000 mixed idle/running/input-needed events stay ordered within a 100ms p95 SSE budget", async (t) => {
  const reader = await open("ws://load-test");
  await reader.read();
  const sent: number[] = [];
  for (let index = 0; index < 1000; index++) {
    sent.push(performance.now());
    emit({ type: "sessionAdded", session: {
      resource: `load-${index}`, title: "Load", provider: "fake", status: [1, 8, 24][index % 3], createdAt: "", modifiedAt: "",
    } });
  }
  const latencies: number[] = [];
  for (let index = 0; index < 1000; index++) {
    const event = JSON.parse(new TextDecoder().decode((await reader.read()).value).slice(6));
    latencies.push(performance.now() - sent[index]);
    assert.equal(event.card.id, `load-${index}`);
    assert.equal(event.sequence, index + 2);
  }
  latencies.sort((a, b) => a - b);
  t.diagnostic(`synthetic ingress-to-reader p95=${latencies[949].toFixed(1)}ms; 1000-event burst, small payloads, model off-path`);
  assert.ok(latencies[949] <= 100, `p95=${latencies[949].toFixed(1)}ms`);
  await reader.cancel();
});

test("an explicit pending-input removal cannot be resurrected by projection fallback", async () => {
  const reader = await open("ws://input-removal");
  await reader.read();
  const session = { resource: "pending", title: "Pending", status: 24, provider: "fake", createdAt: "", modifiedAt: "" };
  emit({ type: "sessionAdded", session, pendingInput: { requestId: "request-1", message: "Choose", questions: [] } });
  const initial = JSON.parse(new TextDecoder().decode((await reader.read()).value).slice(6));
  assert.equal(initial.card.pendingInput.requestId, "request-1");
  emit({ type: "sessionSummaryChanged", session, pendingInput: null });
  const removed = JSON.parse(new TextDecoder().decode((await reader.read()).value).slice(6));
  assert.equal(removed.card.pendingInput, undefined);
  await reader.cancel();
});

test("unchanged facts cannot repeatedly spend model work after a triage failure", async () => {
  state.riskStatus = "missing";
  state.triageError = new Error("model unavailable");
  const reader = await open("ws://model-failure");
  await reader.read();
  const before = state.triages;
  const session = { resource: "failed-model", title: "Failed", provider: "fake", status: 1, createdAt: "", modifiedAt: "" };
  emit({ type: "sessionAdded", session });
  await reader.read();
  await tick();
  for (let index = 0; index < 10; index++) {
    emit({ type: "sessionSummaryChanged", session: { ...session, activity: `activity-${index}` } });
    await reader.read();
    await tick();
  }
  assert.equal(state.triages, before + 1);
  await reader.cancel();
  state.riskStatus = "current";
  state.triageError = undefined;
});

test("a slow consumer is disconnected at its byte budget without closing a healthy subscriber", async () => {
  const slow = await open("ws://buffer-test");
  const healthy = await open("ws://buffer-test");
  await healthy.read();
  for (let index = 0; index < 5; index++) {
    const session = { resource: `buffer-${index}`, title: "x".repeat(2 * 1024 * 1024), provider: "fake", status: 8, createdAt: "", modifiedAt: "" };
    emit({ type: "sessionAdded", session });
    assert.equal(JSON.parse(new TextDecoder().decode((await healthy.read()).value).slice(6)).card.id, session.resource);
  }
  await assert.rejects(slow.read(), /buffer exceeded/);
  assert.equal(state.bridge!.signal!.aborted, false);
  await healthy.cancel();
  assert.equal(state.bridge!.signal!.aborted, true);
});

test("archives are counted without projection and loaded on demand over the shared host bridge", async (t) => {
  state.sessions.clear();
  t.after(() => state.sessions.clear());
  const host = "ws://archive-demand";
  const decode = (value?: Uint8Array) => JSON.parse(new TextDecoder().decode(value).slice(6));
  const archives = Array.from({ length: 1000 }, (_, index) => ({
    resource: `archive-demand-${index}`, title: "Archived", provider: "fake",
    status: 65, createdAt: "", modifiedAt: "",
    changes: { files: 1, additions: 1, deletions: 0 },
  }));
  for (const session of archives) state.sessions.set(session.resource, session);
  state.projections.length = 0;
  const beforeBridges = state.bridges;
  const beforeCompletions = state.archiveCompletions;
  const reader = await open(host);
  const cached = decode((await reader.read()).value);
  assert.equal(cached.archivedCount, 1000);
  assert.equal(cached.cards.some((card: { isArchived: boolean }) => card.isArchived), false);
  assert.equal(state.projections.some((id) => id.startsWith("archive-demand-")), false);

  const active = { ...archives[0], resource: "archive-demand-active", status: 1 };
  emit({
    type: "init", sessions: [active, ...archives], enrichments: new Map(),
    pendingInputs: new Map(), workers: new Map(),
    connection: {
      logicalUrl: host, transport: "websocket", resolvedTarget: host,
      candidateCount: 1, compatibleCandidateCount: 1, protocolVersion: "1.0.0",
      totalSessions: 1001, visibleSessions: 1001, filteredSessions: 0,
    },
  });
  const live = decode((await reader.read()).value);
  assert.deepEqual(live.cards.map((card: { id: string }) => card.id), [active.resource]);
  assert.equal(live.archivedCount, 1000);
  assert.equal(live.connection.filteredSessions, 0, "hidden archives are not disabled/empty sessions");
  assert.equal(state.projections.filter((id) => archives.some((session) => session.resource === id)).length, 0);
  assert.deepEqual(state.getHosts!()[0].cards.map((card) => card.id), [active.resource]);

  const archiveReader = await open(host, true);
  const archiveInit = decode((await archiveReader.read()).value);
  assert.equal(archiveInit.cards.length, 1000);
  assert.equal(state.bridges, beforeBridges + 1, "archive demand must not reconnect AHP");
  const projected = state.projections.length;
  const peer = await open(host, true);
  assert.equal(decode((await peer.read()).value).cards.length, 1000);
  assert.equal(state.projections.length, projected, "archive projection is shared, not per subscriber");
  await peer.cancel();

  emit({ type: "sessionSummaryChanged", session: { ...archives[0], status: 1 } });
  assert.equal(decode((await reader.read()).value).card.id, archives[0].resource);
  const unarchived = decode((await archiveReader.read()).value);
  assert.equal(unarchived.type, "cardRemoved");
  assert.equal(unarchived.archivedCount, 999);
  emit({ type: "sessionSummaryChanged", session: { ...active, status: 65 } });
  assert.equal(decode((await reader.read()).value).type, "cardRemoved");
  assert.equal(decode((await archiveReader.read()).value).card.isArchived, true);
  assert.equal(state.getHosts!()[0].cards.some((card) => card.id === active.resource), false);

  await archiveReader.cancel();
  assert.equal(state.bridge!.signal!.aborted, false);
  const beforeUpdate = state.projections.length;
  emit({ type: "sessionSummaryChanged", session: { ...archives[1], title: "Changed while hidden" } });
  const hiddenUpdate = decode((await reader.read()).value);
  assert.equal(hiddenUpdate.archivedCount, 1000);
  assert.equal(hiddenUpdate.archivedSession, undefined, "catalog metadata stays server-side");
  assert.equal(state.projections.length, beforeUpdate);
  assert.equal(state.archiveCompletions, beforeCompletions + 1, "only observed archiving creates an inbox completion");
  emit({ type: "sessionRemoved", resource: archives[1].resource });
  assert.equal(decode((await reader.read()).value).archivedCount, 999);
  await reader.cancel();
  for (const session of [...archives, active]) state.sessions.delete(session.resource);
});

test("an archive viewer cannot widen automation scope or keep automation authorized alone", async () => {
  state.sessions.clear();
  const host = "ws://archive-scope";
  const primary = await open(host, false, ["/selected-workspace"]);
  await primary.read();
  emit({
    type: "init",
    sessions: [{ resource: "outside-scope", title: "Outside", provider: "fake", status: 1, createdAt: "", modifiedAt: "" }],
    enrichments: new Map(), pendingInputs: new Map(), workers: new Map(),
    connection: {
      logicalUrl: host, transport: "websocket", resolvedTarget: host,
      candidateCount: 1, compatibleCandidateCount: 1, protocolVersion: "1.0.0",
      totalSessions: 1, visibleSessions: 1, filteredSessions: 0,
    },
  });
  await primary.read();
  const archive = await open(host, true);
  await archive.read();
  assert.deepEqual(state.getHosts!()[0].cards, []);
  await primary.cancel();
  assert.equal(state.bridge!.signal!.aborted, false);
  assert.deepEqual(state.getHosts!()[0].cards, []);
  await archive.cancel();
});
