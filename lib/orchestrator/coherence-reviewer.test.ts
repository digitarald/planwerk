import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { after, beforeEach, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import Database from "better-sqlite3";
import type { Changeset, ChangesetFile } from "@microsoft/agent-host-protocol";
import type { MessageOptions, ResponseSchema } from "@github/copilot-sdk";
import type { KanbanCard, Phase, RiskLevel } from "../types.ts";

const HOST = "ws://coherence.test";
const FILE = "/repo/src/x/shared.ts";
const IDS = ["copilotcli:/a", "copilotcli:/b"];
const db = new Database(":memory:");
db.exec(`
  CREATE TABLE session_cache (
    session_uri TEXT PRIMARY KEY, host_url TEXT, summary_json TEXT, enrichment_json TEXT
  );
  CREATE TABLE coherence_conflicts (
    id INTEGER PRIMARY KEY, card_a TEXT, card_b TEXT, tier TEXT,
    overlap_paths TEXT, signature TEXT, status TEXT, risk_snapshot TEXT,
    verdict_summary TEXT, findings_json TEXT, dismissed_signature TEXT,
    updated_at TEXT DEFAULT (datetime('now')), resolved_at TEXT, resolved_by TEXT,
    review_owner_id TEXT, review_lease_expires_at_ms INTEGER,
    UNIQUE(card_a, card_b)
  );
  CREATE TABLE heartbeat_log (detection TEXT, card_id TEXT, action_taken TEXT, detail TEXT);
`);

const state = {
  status: 8,
  phase: "review" as Phase,
  risk: "medium" as RiskLevel | undefined,
  changesets: undefined as Changeset[] | undefined,
  files: undefined as ChangesetFile[] | undefined,
  changesetStatus: "ready",
  missingContent: false,
  failedRead: false,
  text: "export const answer = 42;",
  result: { status: "coherent", summary: "Independent edits.", findings: [] } as unknown,
  sdkError: undefined as Error | undefined,
  calls: [] as string[],
  resident: new Set<string>(),
  onRead: undefined as (() => void) | undefined,
  onSend: undefined as (() => void) | undefined,
  onCatalog: undefined as (() => void) | undefined,
};

function file(): ChangesetFile {
  return {
    id: "shared",
    edit: {
      after: {
        uri: `file://${FILE}`,
        ...(state.missingContent ? {} : { content: { uri: "content:/shared" } }),
      },
      diff: { added: 1, removed: 1 },
    },
  } as ChangesetFile;
}

const ahp = {
  resident: new Set<string>(),
  async subscribe(uri: string) {
    state.calls.push(`subscribe:${uri}`);
    let snapshotState: unknown;
    if (IDS.includes(uri)) {
      this.resident.add(uri);
      state.resident.add(uri);
      snapshotState = {
        chats: [],
        changesets: state.changesets ?? [{
          changeKind: "session", label: "Session", uriTemplate: `ahp-changeset:/${IDS.indexOf(uri)}`,
        }],
      };
    } else {
      assert.equal(this.resident.size, 1, "changeset reads retain parent residency");
      snapshotState = { status: state.changesetStatus, files: state.files ?? [file()] };
    }
    let end!: (value: { done: true; value: undefined }) => void;
    const next = new Promise<{ done: true; value: undefined }>((resolve) => { end = resolve; });
    return {
      result: { snapshot: { resource: uri, state: snapshotState } },
      subscription: {
        next() { return next; },
        async close() { state.calls.push(`close:${uri}`); end({ done: true, value: undefined }); },
      },
    };
  },
  async unsubscribe(uri: string) {
    state.calls.push(`unsubscribe:${uri}`);
    this.resident.delete(uri);
    state.resident.delete(uri);
  },
  async request(method: string) {
    state.calls.push(method);
    if (method === "listSessions") {
      state.onCatalog?.();
      return { items: IDS.map((resource) => ({ resource, status: state.status })) };
    }
    assert.equal(method, "resourceRead");
    assert.equal(this.resident.size, 1, "file reads retain parent residency");
    state.onRead?.();
    if (state.failedRead) throw new Error("Resource unavailable");
    return { data: state.text, encoding: "utf-8" };
  },
};
const runtime = {
  client: {
    async createSession() {
      state.calls.push("createSession");
      return {
        sessionId: "coherence-review",
        async sendAndWait(message: MessageOptions, schema: ResponseSchema, timeout: number) {
          state.calls.push("sendAndWait");
          assert.equal(message.source, "system");
          assert.equal(timeout, 45_000);
          state.onSend?.();
          if (state.sdkError) throw state.sdkError;
          return schema.parse(state.result);
        },
        async abort() { state.calls.push("abort"); },
        async disconnect() { state.calls.push("disconnect"); },
      };
    },
    async deleteSession() { state.calls.push("deleteSession"); },
  },
  async release() { state.calls.push("release"); },
  async invalidate() { state.calls.push("invalidate"); return true; },
};
const key = "__planwerkCoherenceRealModuleTest";
Object.defineProperty(globalThis, key, {
  value: { db, ahp, runtime, state }, configurable: true,
});
const root = path.resolve(import.meta.dirname, "../..");
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    let source: string | undefined;
    if (specifier === "server-only") source = "export {}";
    if (specifier === "@/lib/db/schema") {
      source = `export function getDb() { return globalThis["${key}"].db; }`;
    }
    if (specifier === "@/lib/ahp/client-operation") {
      source = `export async function withAHPClient(_host, operation) {
        const root = globalThis["${key}"];
        const client = Object.create(root.ahp);
        client.resident = new Set();
        return operation(client);
      }`;
    }
    if (specifier === "./risk-store" || specifier === "@/lib/orchestrator/risk-store") {
      source = `export function getRiskForAutomation() { return globalThis["${key}"].state.risk; }
        export function getAuthoritativeCardRisk() {
          return {status:"current",assessment:{level:globalThis["${key}"].state.risk}};
        }`;
    }
    if (specifier === "./gate-engine" || specifier === "@/lib/orchestrator/gate-engine") {
      source = `export function setCardPhase(id, phase) {
          const state=globalThis["${key}"].state;
          state.calls.push("phase:" + id + ":" + phase); state.phase=phase;
        }
        export function getCardPhase() { return globalThis["${key}"].state.phase; }
        export function getNextPhase(phase) { return {review:"ship",build:"review",plan:"build",define:"plan"}[phase]; }
        export function logManualOverride(id, from, to, direction) {
          globalThis["${key}"].state.calls.push("override:" + id + ":" + from + ":" + to + ":" + direction);
        }
        export function canAdvancePhase() { return {allowed:true,pendingGates:[]}; }
        export function getGatesForTransition() { return []; }
        export function completeGateRun() {}
        export function executeGateCommand() {}
        export function resolveConfiguredGate() {}
        export function startGateRun() {}`;
    }
    if (specifier === "next/server") {
      source = `export class NextRequest extends Request {}
        export const NextResponse = {json: (body, init) => Response.json(body, init)};`;
    }
    if (specifier === "@/lib/orchestrator/skill-config") {
      source = `export function loadConfig() {
        return {coherence:{enabled:true,moduleDepth:2,blockHighRiskShip:true}};
      }`;
    }
    if (specifier === "./sdk-runtime") {
      source = `export async function acquireCopilotRuntimeClient() {
        globalThis["${key}"].state.calls.push("acquireRuntime");
        return globalThis["${key}"].runtime;
      }
      export function classifyCopilotFailure() { return "domain"; }`;
    }
    if (specifier === "./model") {
      source = 'export async function selectOrchestratorModel() { return {model:"test-model"}; }';
    }
    if (source) return { shortCircuit: true, url: `data:text/javascript,${encodeURIComponent(source)}` };
    if (specifier.startsWith("@/")) {
      return { shortCircuit: true, url: pathToFileURL(path.join(root, `${specifier.slice(2)}.ts`)).href };
    }
    if (specifier.startsWith(".") && !path.extname(specifier) &&
        context.parentURL?.startsWith("file:")) {
      const candidate = fileURLToPath(new URL(`${specifier}.ts`, context.parentURL));
      if (existsSync(candidate)) return { shortCircuit: true, url: pathToFileURL(candidate).href };
    }
    return nextResolve(specifier, context);
  },
});

const { fetchOverlapContent } = await import("./coherence-content.ts");
const { runCoherenceExecutor } = await import("./coherence-reviewer.ts");
const { advanceReviewToShip } = await import("./phase-advance.ts");
const { POST: postGate } = await import("../../app/api/gates/run/route.ts");
const {
  syncCoherence, DEFAULT_COHERENCE_CONFIG, claimForReviewOwner, completeReview,
  isCoherenceReviewCurrent, getShipBlockingConflicts, dismissConflict, buildCoherenceSummary,
} = await import("./coherence-engine.ts");
const { claimSessionOwnership, ensureSessionOwnershipSchema } = await import("../db/session-ownership.ts");
ensureSessionOwnershipSchema(db);

after(() => {
  hooks.deregister();
  Reflect.deleteProperty(globalThis, key);
  db.close();
});

beforeEach(() => {
  db.exec("DELETE FROM session_cache; DELETE FROM coherence_conflicts; DELETE FROM heartbeat_log; DELETE FROM session_uri_ownership;");
  Object.assign(state, {
    status: 8, phase: "review", risk: "medium", changesets: undefined, files: undefined,
    changesetStatus: "ready", missingContent: false, failedRead: false,
    text: "export const answer = 42;",
    result: { status: "coherent", summary: "Independent edits.", findings: [] },
    sdkError: undefined, onRead: undefined, onSend: undefined, onCatalog: undefined,
  });
  state.calls.length = 0;
  state.resident.clear();
});

function cache(id: string, revision: string, options: { verified?: boolean; host?: string } = {}) {
  const binding = { sourceRevision: revision, planVersion: "plan-1" };
  db.prepare(`
    INSERT OR REPLACE INTO session_cache VALUES (?, ?, ?, ?)
  `).run(id, options.host ?? HOST, JSON.stringify({ resource: id, _planwerkRiskFacts: binding }),
    JSON.stringify({
      changesetVerified: options.verified ?? true, totalFileCount: 1, additions: 1, deletions: 1,
      _planwerkSource: binding,
    }));
}

function cards(): KanbanCard[] {
  return IDS.map((id) => {
    cache(id, `${id}-v1`);
    return {
      id, phase: "build", workingDirectory: "/repo", sourceRevision: `${id}-v1`,
      changesetVerified: true, fileChanges: [{ path: FILE, added: 1, removed: 1 }],
    } as KanbanCard;
  });
}

function persisted() {
  return db.prepare("SELECT * FROM coherence_conflicts").get() as {
    status: string; verdict_summary: string | null; review_owner_id: string | null;
    review_lease_expires_at_ms: number | null; signature: string;
    deferral_reason: string | null; wake_condition: string | null;
    retry_at_ms: number | null; failure_attempts: number;
  };
}

function rows() {
  return syncCoherence(cards(), DEFAULT_COHERENCE_CONFIG, HOST);
}

async function drag(toPhase: Phase, extra: Record<string, unknown> = {}) {
  return postGate(new Request("http://127.0.0.1:3000/api/gates/run", {
    method: "POST",
    headers: {
      "content-type": "application/json", host: "127.0.0.1:3000",
      origin: "http://127.0.0.1:3000", "sec-fetch-site": "same-origin",
    },
    body: JSON.stringify({ cardId: IDS[0], action: "transition", toPhase, ...extra }),
  }) as Parameters<typeof postGate>[0]);
}

test("DnD review-to-ship cannot bypass coherence or substitute a request-supplied host", async () => {
  rows();
  state.risk = "high";
  const response = await drag("ship", { hostUrl: "ws://unrelated-host" });
  assert.equal(response.status, 409);
  const payload = await response.json();
  assert.equal(payload.error, "Blocked by unresolved coherence conflict");
  assert.equal(payload.coherenceConflicts.length, 1);
  assert.equal(state.phase, "review");
  assert.equal(state.calls.some((call) => call.startsWith("phase:") || call.startsWith("override:")), false);
});

test("DnD review-to-ship rejects unavailable and quarantined source authority without override", async () => {
  assert.equal((await drag("ship")).status, 409);
  rows();
  assert.equal(claimSessionOwnership(db, IDS[0], HOST), true);
  assert.equal(claimSessionOwnership(db, IDS[0], "ws://collision"), false);
  assert.equal((await drag("ship")).status, 409);
  assert.equal(state.phase, "review");
  assert.equal(state.calls.some((call) => call.startsWith("phase:") || call.startsWith("override:")), false);
});

test("DnD review-to-ship uses current owned facts and preserves the deliberate override audit", async () => {
  rows();
  const response = await drag("ship");
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.manualOverride, true);
  assert.equal(payload.newPhase, "ship");
  assert.deepEqual(state.calls, [
    `phase:${IDS[0]}:ship`,
    `override:${IDS[0]}:review:ship:forward`,
  ]);
});

test("DnD backwards rework remains possible without live source evidence", async () => {
  state.phase = "ship";
  const response = await drag("build");
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.direction, "backward");
  assert.equal(payload.manualOverride, false);
  assert.deepEqual(state.calls, [
    `phase:${IDS[0]}:build`,
    `override:${IDS[0]}:ship:build:backward`,
  ]);
});

test("only a static session changeset is selected; workspace fallback is never evidence", async () => {
  for (const changesets of [
    [{ changeKind: "uncommitted", label: "Worktree", uriTemplate: "ahp-changeset:/worktree" }],
    [{ changeKind: "unknown", label: "Static", uriTemplate: "ahp-changeset:/static" }],
    [{ changeKind: "session", label: "Template", uriTemplate: "ahp-changeset:/{turnId}" }],
  ]) {
    state.changesets = changesets;
    const content = await fetchOverlapContent(HOST, IDS[0], "file", [FILE]);
    assert.equal(content.status, "deferred");
    assert.equal(content.failed, true);
    assert.equal(state.calls.some((call) => call.startsWith("subscribe:ahp-changeset:")), false);
  }
  state.changesets = [
    { changeKind: "branch", label: "Branch", uriTemplate: "ahp-changeset:/branch" },
    { changeKind: "session", label: "Session", uriTemplate: "ahp-changeset:/session" },
  ];
  const content = await fetchOverlapContent(HOST, IDS[0], "file", [FILE]);
  assert.equal(content.status, "ready");
  assert.ok(state.calls.includes("subscribe:ahp-changeset:/session"));
  assert.equal(state.calls.includes("subscribe:ahp-changeset:/branch"), false);
  assert.equal(state.resident.size, 0);
});

test("cold medium-risk pairs defer passively without SDK work or repeated reads", async () => {
  const pending = rows();
  state.status = 1;
  assert.deepEqual(await runCoherenceExecutor(HOST, pending, new Map()), []);
  assert.equal(state.calls.filter((call) => call === "listSessions").length, 2);
  assert.equal(state.calls.some((call) => call.startsWith("subscribe:")), false);
  assert.equal(state.calls.includes("acquireRuntime"), false);
  assert.equal(persisted().status, "detected");
  assert.equal(persisted().review_owner_id, null);
  assert.equal(persisted().wake_condition, "activation-change");
  assert.equal(persisted().retry_at_ms, null);
  const count = state.calls.length;
  assert.deepEqual(await runCoherenceExecutor(HOST, pending, new Map()), []);
  assert.equal(state.calls.length, count);
  assert.deepEqual(syncCoherence(cards(), DEFAULT_COHERENCE_CONFIG, HOST), []);
});

test("refreshed cold high-risk evidence explicitly remains unsupported for automatic coherence review", async () => {
  const pending = rows();
  state.status = 1;
  state.risk = "high";
  await runCoherenceExecutor(HOST, pending, new Map());
  const refreshed = cards().map((card) => {
    const revision = `${card.id}-captured-by-explicit-refresh`;
    cache(card.id, revision);
    return { ...card, sourceRevision: revision };
  });
  const awakened = syncCoherence(refreshed, DEFAULT_COHERENCE_CONFIG, HOST);
  assert.equal(awakened.length, 1);
  assert.deepEqual(await runCoherenceExecutor(HOST, awakened, new Map()), []);
  assert.equal(persisted().deferral_reason, "inactive-session");
  assert.equal(persisted().wake_condition, "activation-change");
  assert.match(persisted().verdict_summary!, /Explicit refresh captures digests, not reviewable code/);
  assert.match(persisted().verdict_summary!, /cold-session review is unsupported/);
  assert.equal(getShipBlockingConflicts(IDS[0], DEFAULT_COHERENCE_CONFIG, HOST).length, 1);
  assert.equal(state.calls.some((call) => call.startsWith("subscribe:") || call === "acquireRuntime"), false);
  const calls = state.calls.length;
  assert.deepEqual(await runCoherenceExecutor(HOST, awakened, new Map()), []);
  assert.equal(state.calls.length, calls);
});

test("archived running sessions never subscribe", async () => {
  state.status = 8 | 64;
  const result = await fetchOverlapContent(HOST, IDS[0], "file", [FILE]);
  assert.equal(result.status, "deferred");
  assert.equal(state.calls.some((call) => call.startsWith("subscribe:")), false);
});

test("failed/missing file reads leave high-risk pairs provisionally blocked, not needs-human", async () => {
  for (const missing of [true, false]) {
    db.exec("DELETE FROM coherence_conflicts;");
    const pending = rows();
    state.risk = "high";
    state.missingContent = missing;
    state.failedRead = !missing;
    assert.deepEqual(await runCoherenceExecutor(HOST, pending, new Map()), []);
    assert.equal(persisted().status, "detected");
    assert.equal(getShipBlockingConflicts(IDS[0]).length, 1);
    assert.equal(state.calls.includes("acquireRuntime"), false);
  }
});

test("missing risk authority cannot silently downgrade an existing ship blocker", () => {
  rows();
  state.risk = "high";
  assert.equal(getShipBlockingConflicts(IDS[0]).length, 1);
  state.risk = undefined;
  assert.equal(getShipBlockingConflicts(IDS[0]).length, 1);
});

test("changed passive catalog facts and canceled ownership refuse complete evidence", async () => {
  state.onRead = () => { state.status = 1; };
  const changed = await fetchOverlapContent(HOST, IDS[0], "file", [FILE]);
  assert.equal(changed.status, "deferred");
  if (changed.status === "deferred") assert.equal(changed.reason, "evidence-changed");
  assert.equal(state.resident.size, 0);
  state.calls.length = 0;
  let current = true;
  state.onCatalog = () => { current = false; };
  const canceled = await fetchOverlapContent(HOST, IDS[0], "file", [FILE], { isCurrent: () => current });
  assert.equal(canceled.status, "deferred");
  assert.equal(state.calls.some((call) => call.startsWith("subscribe:")), false);
});

test("evidence byte limits count UTF-8 rather than JavaScript code units", async () => {
  state.text = "🙂".repeat(2_001);
  const content = await fetchOverlapContent(HOST, IDS[0], "file", [FILE]);
  assert.equal(content.status, "deferred");
  if (content.status === "deferred") assert.equal(content.reason, "evidence-limit");
});

test("empty, incomplete, truncated, and unready changesets defer without an SDK verdict", async () => {
  const pending = rows();
  for (const setup of [
    () => { state.files = []; },
    () => { state.changesetStatus = "error"; },
    () => { state.text = "x".repeat(8_001); },
  ]) {
    state.files = undefined;
    state.changesetStatus = "ready";
    state.text = "code";
    setup();
    db.prepare("UPDATE coherence_conflicts SET review_lease_expires_at_ms = NULL, wake_condition = NULL").run();
    assert.deepEqual(await runCoherenceExecutor(HOST, pending, new Map()), []);
    assert.equal(persisted().status, "detected");
    assert.equal(state.calls.includes("acquireRuntime"), false);
  }
  assert.equal((await fetchOverlapContent(HOST, IDS[0], "file", [FILE, "/repo/missing.ts"])).failed, true);
});

test("deletions use previous content and module bounds never include prefix siblings", async () => {
  state.files = [{
    id: "deleted", edit: { before: { uri: `file://${FILE}`, content: { uri: "content:/deleted" } } },
  }];
  const deleted = await fetchOverlapContent(HOST, IDS[0], "file", [FILE]);
  assert.equal(deleted.status, "ready");
  assert.equal(deleted.files[0].deleted, true);
  assert.equal(deleted.files[0].content, state.text);
  state.files = [{
    id: "other", edit: { after: { uri: "src/xtra/file.ts", content: { uri: "content:/other" } } },
  }];
  assert.equal((await fetchOverlapContent(HOST, IDS[0], "module", ["src/x"])).status, "deferred");
  state.files = Array.from({ length: 6 }, (_, index) => ({
    id: String(index),
    edit: { after: { uri: `file:///repo/src/x/${index}.ts`, content: { uri: `content:/${index}` } } },
  }));
  assert.equal((await fetchOverlapContent(HOST, IDS[0], "module", ["src/x"])).status, "deferred");
});

test("count-identical revision changes reopen an accepted verdict", async () => {
  const current = cards();
  const pending = syncCoherence(current, DEFAULT_COHERENCE_CONFIG, HOST);
  assert.equal((await runCoherenceExecutor(HOST, pending, new Map()))[0].status, "coherent");
  const oldSignature = persisted().signature;
  assert.equal(persisted().status, "coherent");
  assert.deepEqual(state.calls.filter((call) =>
    ["createSession", "sendAndWait", "deleteSession", "release"].includes(call)),
  ["createSession", "sendAndWait", "deleteSession", "release"]);
  current[0].sourceRevision = "semantic-edit-v2";
  cache(IDS[0], current[0].sourceRevision);
  const reopened = syncCoherence(current, DEFAULT_COHERENCE_CONFIG, HOST);
  assert.equal(reopened.length, 1);
  assert.notEqual(reopened[0].signature, oldSignature);
  assert.equal(persisted().status, "detected");
  assert.equal(persisted().verdict_summary, null);
});

test("a revision changed while reading is rejected before acquiring the SDK", async () => {
  const pending = rows();
  state.onRead = () => { cache(IDS[0], "changed-during-read"); };
  assert.deepEqual(await runCoherenceExecutor(HOST, pending, new Map()), []);
  assert.equal(persisted().status, "detected");
  assert.equal(state.calls.includes("acquireRuntime"), false);
});

test("ship blocking rechecks settled source revisions without waiting for the next sync", async () => {
  const pending = rows();
  state.risk = "high";
  await runCoherenceExecutor(HOST, pending, new Map());
  assert.equal(getShipBlockingConflicts(IDS[0]).length, 0);
  cache(IDS[0], "same-count-semantic-edit");
  assert.equal(getShipBlockingConflicts(IDS[0]).length, 1);
  assert.equal(persisted().status, "detected");
  assert.equal(persisted().verdict_summary, null);
});

test("missing enrichment cannot auto-resolve a deferred overlapping pair", async () => {
  const current = cards();
  syncCoherence(current, DEFAULT_COHERENCE_CONFIG, HOST);
  current[0].changesetVerified = false;
  current[0].fileChanges = undefined;
  syncCoherence(current, DEFAULT_COHERENCE_CONFIG, HOST);
  assert.equal(persisted().status, "detected");
});

test("another host's tick cannot clean up or claim the first host's conflicts", () => {
  const pending = rows();
  assert.deepEqual(syncCoherence([], DEFAULT_COHERENCE_CONFIG, "ws://another", {
    authoritativeSessionUris: new Set(),
  }), []);
  assert.equal(persisted().status, "detected");
  assert.equal(claimForReviewOwner(pending[0].id, pending[0].signature, "foreign", "ws://another"), false);
  assert.equal(persisted().review_owner_id, null);
});

test("legacy conflicts with unavailable host binding remain fail-closed ship blockers", () => {
  rows();
  state.risk = "high";
  db.prepare("UPDATE coherence_conflicts SET host_url = NULL").run();
  syncCoherence([], DEFAULT_COHERENCE_CONFIG, "ws://unrelated", {
    authoritativeSessionUris: new Set(),
  });
  assert.equal(persisted().status, "detected");
  assert.equal(getShipBlockingConflicts(IDS[0], DEFAULT_COHERENCE_CONFIG, HOST).length, 1);
});

test("coherence summary forwards the expected host and config without exposing another host's conflicts", () => {
  rows();
  state.risk = "high";
  db.prepare("UPDATE coherence_conflicts SET status = 'conflict'").run();
  const own = buildCoherenceSummary(IDS[0], undefined, DEFAULT_COHERENCE_CONFIG, HOST);
  assert.equal(own?.blocking, true);
  assert.equal(own?.peers.length, 1);
  assert.equal(buildCoherenceSummary(IDS[0], undefined, DEFAULT_COHERENCE_CONFIG, "ws://unowned"), null);
  const advisory = buildCoherenceSummary(IDS[0], undefined,
    { ...DEFAULT_COHERENCE_CONFIG, blockHighRiskShip: false }, HOST);
  assert.equal(advisory?.blocking, false);
  assert.equal(advisory?.peers.length, 1);
  db.prepare("UPDATE coherence_conflicts SET host_url = 'ws://foreign-row'").run();
  assert.equal(buildCoherenceSummary(IDS[0], undefined, DEFAULT_COHERENCE_CONFIG, HOST), null);
});

test("raw cache host fallback cannot authorize quarantined coherence display", () => {
  rows();
  state.risk = "high";
  assert.equal(claimSessionOwnership(db, IDS[0], HOST), true);
  assert.equal(getShipBlockingConflicts(IDS[0]).length, 1);
  assert.equal(claimSessionOwnership(db, IDS[0], "ws://collision"), false);
  assert.deepEqual(getShipBlockingConflicts(IDS[0]), []);
  assert.deepEqual(getShipBlockingConflicts(IDS[0], DEFAULT_COHERENCE_CONFIG, HOST), []);
  assert.equal(buildCoherenceSummary(IDS[0]), null);
  assert.equal(buildCoherenceSummary(IDS[0], undefined, DEFAULT_COHERENCE_CONFIG, HOST), null);
  assert.equal(advanceReviewToShip(IDS[0], DEFAULT_COHERENCE_CONFIG, HOST).advanced, false);
});

test("mismatched cache fallback cannot reopen settled coherence rows or borrow another host's authority", () => {
  rows();
  assert.equal(claimSessionOwnership(db, IDS[0], HOST), true);
  db.prepare("UPDATE coherence_conflicts SET status = 'coherent', resolved_by = 'reviewer'").run();
  cache(IDS[0], `${IDS[0]}-v1`, { host: "ws://cache-mismatch" });
  assert.deepEqual(getShipBlockingConflicts(IDS[0]), []);
  assert.equal(persisted().status, "coherent");
  assert.equal(buildCoherenceSummary(IDS[0]), null);
  assert.equal(buildCoherenceSummary(IDS[0], undefined, DEFAULT_COHERENCE_CONFIG, "ws://cache-mismatch"), null);
  assert.equal(advanceReviewToShip(IDS[0], DEFAULT_COHERENCE_CONFIG, "ws://cache-mismatch").advanced, false);
});

test("a filtered or unavailable batch never proves removal; explicit complete catalog removal does", () => {
  const current = cards();
  syncCoherence(current, DEFAULT_COHERENCE_CONFIG, HOST);
  syncCoherence([current[0]], DEFAULT_COHERENCE_CONFIG, HOST);
  assert.equal(persisted().status, "detected");
  syncCoherence([], DEFAULT_COHERENCE_CONFIG, HOST);
  assert.equal(persisted().status, "detected");
  syncCoherence([current[0]], DEFAULT_COHERENCE_CONFIG, HOST, {
    authoritativeSessionUris: new Set(IDS),
  });
  assert.equal(persisted().status, "detected");
  syncCoherence([current[0]], DEFAULT_COHERENCE_CONFIG, HOST, {
    authoritativeSessionUris: new Set([IDS[0]]),
  });
  assert.equal(persisted().status, "coherent");
});

test("a stale verified card snapshot cannot resolve a pair against newer cached sources", () => {
  const current = cards();
  syncCoherence(current, DEFAULT_COHERENCE_CONFIG, HOST);
  current[0].fileChanges = [];
  cache(IDS[0], "newer-than-snapshot");
  syncCoherence(current, DEFAULT_COHERENCE_CONFIG, HOST);
  assert.equal(persisted().status, "detected");
});

test("quarantined URI ownership rejects current-source reviews, dismissals, and shipping", async () => {
  const pending = rows();
  const row = pending[0];
  assert.equal(claimSessionOwnership(db, IDS[0], HOST), true);
  assert.equal(claimForReviewOwner(row.id, row.signature, "owner", HOST), true);
  assert.equal(claimSessionOwnership(db, IDS[0], "ws://collision"), false);
  assert.equal(isCoherenceReviewCurrent(row.id, row.signature, "owner", HOST), false);
  assert.equal(completeReview(row.id, row.signature,
    { status: "coherent", summary: "Unsafe acceptance", findings: [] }, "owner", Date.now(), HOST), false);
  assert.equal(dismissConflict(IDS[0], IDS[1], HOST), null);
  assert.equal(advanceReviewToShip(IDS[0], { ...DEFAULT_COHERENCE_CONFIG, enabled: false }, HOST).advanced, false);
  assert.equal(state.calls.some((call) => call.startsWith("phase:")), false);
});

test("ship requires an explicit matching host even if coherence checks are disabled", () => {
  rows();
  const config = { ...DEFAULT_COHERENCE_CONFIG, enabled: false };
  // @ts-expect-error Exercise JavaScript callers omitting the required production host.
  assert.equal(advanceReviewToShip(IDS[0], config).advanced, false);
  assert.equal(advanceReviewToShip(IDS[0], config, "ws://wrong").advanced, false);
  assert.equal(advanceReviewToShip(IDS[0], config, HOST).advanced, true);
  assert.equal(state.calls.filter((call) => call.startsWith("phase:")).length, 1);
});

test("evidence over limit is explicitly unsupported and never periodically retries or starts the SDK", async () => {
  const current = cards().map((card) => ({
    ...card,
    fileChanges: Array.from({ length: 6 }, (_, index) => ({ path: `/repo/src/x/${index}.ts`, added: 1, removed: 1 })),
  }));
  const pending = syncCoherence(current, DEFAULT_COHERENCE_CONFIG, HOST);
  assert.deepEqual(await runCoherenceExecutor(HOST, pending, new Map()), []);
  assert.equal(persisted().deferral_reason, "evidence-limit");
  assert.equal(persisted().wake_condition, "signature-change");
  assert.match(persisted().verdict_summary!, /Unsupported.*chunked review is not supported/);
  assert.equal(state.calls.includes("acquireRuntime"), false);
  const calls = state.calls.length;
  assert.deepEqual(await runCoherenceExecutor(HOST, pending, new Map()), []);
  assert.deepEqual(syncCoherence(current, DEFAULT_COHERENCE_CONFIG, HOST), []);
  assert.equal(state.calls.length, calls);
});

test("invalid structured reviewer output stops after two attempts for the same signature", async () => {
  const pending = rows();
  state.result = { status: "not-a-verdict" };
  await runCoherenceExecutor(HOST, pending, new Map());
  assert.equal(persisted().deferral_reason, "invalid-model-output");
  assert.equal(persisted().failure_attempts, 1);
  db.prepare("UPDATE coherence_conflicts SET retry_at_ms = 0, review_lease_expires_at_ms = 0").run();
  await runCoherenceExecutor(HOST, pending, new Map());
  assert.equal(persisted().failure_attempts, 2);
  assert.equal(persisted().wake_condition, "manual");
  await runCoherenceExecutor(HOST, pending, new Map());
  assert.equal(state.calls.filter((call) => call === "createSession").length, 2);
  assert.equal(persisted().status, "detected");
});

test("generation cancellation during the SDK call discards the verdict and releases the runtime", async () => {
  const pending = rows();
  const controller = new AbortController();
  state.onSend = () => controller.abort();
  assert.deepEqual(await runCoherenceExecutor(HOST, pending, new Map(), { signal: controller.signal }), []);
  assert.equal(persisted().status, "detected");
  assert.ok(state.calls.includes("deleteSession"));
  assert.ok(state.calls.includes("release"));
});

test("completion checks current sources, host, owner and lease, even before the next sync", async () => {
  const pending = rows();
  const row = pending[0];
  const verdict = { status: "coherent" as const, summary: "Safe", findings: [] };
  assert.equal(claimForReviewOwner(row.id, row.signature, "owner", HOST), true);
  assert.equal(isCoherenceReviewCurrent(row.id, row.signature, "owner", HOST), true);
  assert.equal(isCoherenceReviewCurrent(row.id, row.signature, "other", HOST), false);
  assert.equal(isCoherenceReviewCurrent(row.id, row.signature, "owner", "ws://wrong"), false);
  assert.equal(completeReview(row.id, row.signature, verdict, "other", Date.now(), HOST), false);
  cache(IDS[0], "changed-before-completion");
  assert.equal(completeReview(row.id, row.signature, verdict, "owner", Date.now(), HOST), false);
  cache(IDS[0], `${IDS[0]}-v1`);
  db.prepare("UPDATE coherence_conflicts SET review_lease_expires_at_ms = 1").run();
  assert.equal(completeReview(row.id, row.signature, verdict, "owner", Date.now(), HOST), false);
});

test("source changes during the SDK call discard verdicts and release for retry", async () => {
  const pending = rows();
  state.onSend = () => { cache(IDS[0], "changed-during-review"); };
  assert.deepEqual(await runCoherenceExecutor(HOST, pending, new Map()), []);
  assert.equal(persisted().status, "detected");
  assert.ok(state.calls.includes("deleteSession"));
  assert.ok(state.calls.includes("release"));
});

test("a human dismissal wins against an in-flight coherence verdict", async () => {
  const pending = rows();
  state.onSend = () => { dismissConflict(IDS[0], IDS[1], HOST); };
  assert.deepEqual(await runCoherenceExecutor(HOST, pending, new Map()), []);
  assert.equal(persisted().status, "dismissed");
});

test("unverified source facts never start AHP or SDK work", async () => {
  const pending = rows();
  cache(IDS[0], `${IDS[0]}-v1`, { verified: false });
  assert.deepEqual(await runCoherenceExecutor(HOST, pending, new Map()), []);
  assert.equal(persisted().status, "detected");
  assert.deepEqual(state.calls, []);
});

test("a host mismatch never reads code or starts reviewer work", async () => {
  const pending = rows();
  cache(IDS[0], `${IDS[0]}-v1`, { host: "ws://different-host" });
  assert.deepEqual(await runCoherenceExecutor(HOST, pending, new Map()), []);
  assert.equal(persisted().status, "detected");
  assert.deepEqual(state.calls, []);
});

test("activation wakes an inactive pair; elapsed wall time alone cannot", async () => {
  const pending = rows();
  state.status = 1;
  await runCoherenceExecutor(HOST, pending, new Map());
  state.status = 8;
  assert.deepEqual(await runCoherenceExecutor(HOST, pending, new Map()), []);
  const activeCards = cards().map((card) => ({ ...card, runtime: "running" as const }));
  const awake = syncCoherence(activeCards, DEFAULT_COHERENCE_CONFIG, HOST);
  assert.equal((await runCoherenceExecutor(HOST, awake, new Map()))[0].status, "coherent");
  assert.equal(persisted().status, "coherent");
  assert.equal(persisted().review_lease_expires_at_ms, null);
});

test("explicit reviewer needs-human remains a verdict rather than infrastructure deferral", async () => {
  const pending = rows();
  state.result = { status: "needs-human", summary: "Architectural tradeoff requires a decision.", findings: [] };
  assert.equal((await runCoherenceExecutor(HOST, pending, new Map()))[0].status, "needs-human");
  assert.equal(persisted().status, "needs-human");
});

test("reviewer unavailability defers with durable cooldown and confirmed cleanup", async () => {
  const pending = rows();
  state.sdkError = new Error("Timeout waiting for response");
  assert.deepEqual(await runCoherenceExecutor(HOST, pending, new Map()), []);
  assert.equal(persisted().status, "detected");
  assert.deepEqual(state.calls.filter((call) =>
    ["abort", "deleteSession", "release"].includes(call)), ["abort", "deleteSession", "release"]);
  const calls = state.calls.length;
  await runCoherenceExecutor(HOST, pending, new Map());
  assert.equal(state.calls.length, calls);
});

test("successful and failed reads clear every coherence timeout", async (t) => {
  const timers = t.mock.method(globalThis, "setTimeout");
  const cleared = t.mock.method(globalThis, "clearTimeout");
  for (const failed of [false, true]) {
    state.failedRead = failed;
    await fetchOverlapContent(HOST, IDS[0], "file", [FILE]);
  }
  assert.ok(timers.mock.calls.length > 0);
  for (const timer of timers.mock.calls) {
    assert.ok(cleared.mock.calls.some((call) => call.arguments[0] === timer.result));
  }
});
