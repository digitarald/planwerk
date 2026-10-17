import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { after, beforeEach, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import Database from "better-sqlite3";
import type { Changeset, ChangesetFile } from "@microsoft/agent-host-protocol";
import type { MessageOptions, ResponseSchema } from "@github/copilot-sdk";
import type { KanbanCard, RiskLevel } from "../types.ts";

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
  risk: "medium" as RiskLevel,
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
    return {
      result: { snapshot: { resource: uri, state: snapshotState } },
      subscription: {
        async close() { state.calls.push(`close:${uri}`); },
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
    if (specifier === "./risk-store") {
      source = `export function getRiskForAutomation() { return globalThis["${key}"].state.risk; }`;
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
const {
  syncCoherence, DEFAULT_COHERENCE_CONFIG, claimForReviewOwner, completeReview,
  isCoherenceReviewCurrent, getShipBlockingConflicts, dismissConflict,
} = await import("./coherence-engine.ts");

after(() => {
  hooks.deregister();
  Reflect.deleteProperty(globalThis, key);
  db.close();
});

beforeEach(() => {
  db.exec("DELETE FROM session_cache; DELETE FROM coherence_conflicts; DELETE FROM heartbeat_log;");
  Object.assign(state, {
    status: 8, risk: "medium", changesets: undefined, files: undefined,
    changesetStatus: "ready", missingContent: false, failedRead: false,
    text: "export const answer = 42;",
    result: { status: "coherent", summary: "Independent edits.", findings: [] },
    sdkError: undefined, onRead: undefined, onSend: undefined,
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
  };
}

function rows() {
  return syncCoherence(cards(), DEFAULT_COHERENCE_CONFIG);
}

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
  assert.ok(persisted().review_lease_expires_at_ms! > Date.now());
  const count = state.calls.length;
  assert.deepEqual(await runCoherenceExecutor(HOST, pending, new Map()), []);
  assert.equal(state.calls.length, count);
  assert.deepEqual(syncCoherence(cards(), DEFAULT_COHERENCE_CONFIG), []);
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
    db.prepare("UPDATE coherence_conflicts SET review_lease_expires_at_ms = NULL").run();
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
  const pending = syncCoherence(current, DEFAULT_COHERENCE_CONFIG);
  assert.equal((await runCoherenceExecutor(HOST, pending, new Map()))[0].status, "coherent");
  const oldSignature = persisted().signature;
  assert.equal(persisted().status, "coherent");
  assert.deepEqual(state.calls.filter((call) =>
    ["createSession", "sendAndWait", "deleteSession", "release"].includes(call)),
  ["createSession", "sendAndWait", "deleteSession", "release"]);
  current[0].sourceRevision = "semantic-edit-v2";
  cache(IDS[0], current[0].sourceRevision);
  const reopened = syncCoherence(current, DEFAULT_COHERENCE_CONFIG);
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
  syncCoherence(current, DEFAULT_COHERENCE_CONFIG);
  current[0].changesetVerified = false;
  current[0].fileChanges = undefined;
  syncCoherence(current, DEFAULT_COHERENCE_CONFIG);
  assert.equal(persisted().status, "detected");
});

test("completion checks current sources, host, owner and lease, even before the next sync", async () => {
  const pending = rows();
  const row = pending[0];
  const verdict = { status: "coherent" as const, summary: "Safe", findings: [] };
  assert.equal(claimForReviewOwner(row.id, row.signature, "owner"), true);
  assert.equal(isCoherenceReviewCurrent(row.id, row.signature, "owner", HOST), true);
  assert.equal(isCoherenceReviewCurrent(row.id, row.signature, "other", HOST), false);
  assert.equal(isCoherenceReviewCurrent(row.id, row.signature, "owner", "ws://wrong"), false);
  assert.equal(completeReview(row.id, row.signature, verdict, "other"), false);
  cache(IDS[0], "changed-before-completion");
  assert.equal(completeReview(row.id, row.signature, verdict, "owner"), false);
  cache(IDS[0], `${IDS[0]}-v1`);
  db.prepare("UPDATE coherence_conflicts SET review_lease_expires_at_ms = 1").run();
  assert.equal(completeReview(row.id, row.signature, verdict, "owner"), false);
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
  state.onSend = () => { dismissConflict(IDS[0], IDS[1]); };
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

test("an expired deferred cooldown retries and can accept complete current evidence", async () => {
  const pending = rows();
  state.status = 1;
  await runCoherenceExecutor(HOST, pending, new Map());
  state.status = 8;
  db.prepare("UPDATE coherence_conflicts SET review_lease_expires_at_ms = ?").run(Date.now() - 1);
  assert.equal((await runCoherenceExecutor(HOST, pending, new Map()))[0].status, "coherent");
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
