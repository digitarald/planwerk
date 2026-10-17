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

const state: {
  bridge?: AHPBridgeOptions;
  getHosts?: () => HeartbeatHostSnapshot[];
  heartbeat: boolean;
  failProjection: boolean;
} = { heartbeat: false, failProjection: false };
const key = "__planwerkEventStreamTest";
Object.defineProperty(globalThis, key, { value: state, configurable: true });
const root = path.resolve(import.meta.dirname, "../..");
const routeUrl = pathToFileURL(path.join(root, "app/api/ahp/events/route.ts")).href;
const mocks: Record<string, string> = {
  "next/server": `export class NextResponse extends Response { static json(value, init) { return new Response(JSON.stringify(value), init); } }`,
  "@/lib/ahp/client-bridge": `export async function createAHPBridge(options) { globalThis["${key}"].bridge = options; }`,
  "@/lib/ahp/enrich-card": `export function enrichSessionToCard(s) { return { id:s.resource, title:s.title, phase:"plan", runtime:s.status === 8 ? "running" : "idle", risk:"medium" }; }`,
  "@/lib/ahp/map-session": `export function mapSessionToCard(s) { return {id:s.resource}; }`,
  "@/lib/ahp/connection-error": `export function classifyError(message) { return {type:"error",message}; }`,
  "@/lib/db/session-cache": `export function getCachedSessions() { return [{summary:{resource:"cached",title:"Cached",status:1}}]; }`,
  "@/lib/orchestrator/triage": `export async function triageCard() {}`,
  "@/lib/orchestrator/gate-engine": `export function getPersistedCardPhase() { if(globalThis["${key}"].failProjection) throw new Error("projection failed"); return "plan"; }`,
  "@/lib/orchestrator/risk-store": `export function getAuthoritativeCardRisk() { return {status:"current"}; } export function getAuthoritativeRiskSnapshot() {}`,
  "@/lib/orchestrator/heartbeat": `export function startHeartbeat(getHosts) { const s=globalThis["${key}"]; s.getHosts=getHosts; s.heartbeat=true; } export async function stopHeartbeat() { globalThis["${key}"].heartbeat=false; } export function isHeartbeatRunning() { return globalThis["${key}"].heartbeat; }`,
  "@/lib/http/local-mutation": `export function validateLocalEventStreamRequest() {}`,
  "@/lib/inbox/service": `export function projectArchivedSessionToInbox() {} export function projectCardToInbox() {} export function projectHeartbeatToInbox() {} export function projectRemovedSessionToInbox() {}`,
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
async function open(host = "ws://fake") {
  const request = { nextUrl: new URL(`http://localhost/api/ahp/events?host=${encodeURIComponent(host)}`) };
  const response = await GET(request as NextRequest);
  return response.body!.getReader();
}
function emit(event: BridgeEvent) { state.bridge!.onEvent(event); }

test("cached initialization is display-only until live init; queued events retain their snapshots", async () => {
  const reader = await open();
  await reader.read();
  assert.deepEqual(state.getHosts!(), []);
  emit({ type: "init", sessions: [], enrichments: new Map(), pendingInputs: new Map(), workers: new Map(), connection: {
    logicalUrl: "ws://fake", transport: "websocket", resolvedTarget: "ws://fake",
    candidateCount: 1, compatibleCandidateCount: 1, protocolVersion: "1.0.0",
    totalSessions: 0, visibleSessions: 0, filteredSessions: 0,
  } });
  await reader.read();
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
