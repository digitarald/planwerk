import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { after, afterEach, mock, test } from "node:test";
import Database from "better-sqlite3";
import { ensureDecisionSchema } from "../db/decision-store.ts";
import type { DecisionResponse } from "./core.ts";

const db = new Database(":memory:");
ensureDecisionSchema(db);
const state: { db: Database.Database; calls: number; response: DecisionResponse; finish?: () => Promise<void>; fail?: boolean } = {
  db, calls: 0, response: { model: "synthetic", answers: { verdict: { type: "choice", choice: "pass",
    probabilities: { pass: 0.99, block: 0.01 } } }, usage: { input_tokens: 10, output_tokens: 1 } },
};
Object.defineProperty(globalThis, "__decisionServiceTest", { value: state, configurable: true });
const hooks = registerHooks({
  resolve(specifier, context, next) {
    let source: string | undefined;
    if (specifier === "server-only") source = "export {}";
    if (context.parentURL?.endsWith("/decisions/service.ts")) {
      if (specifier === "../db/schema.ts") source = "export function getDb(){return globalThis.__decisionServiceTest.db}";
      if (specifier === "./transport.ts") source = `export class DecisionTransportError extends Error{}
        export async function callFoundry(){const s=globalThis.__decisionServiceTest;s.calls++;await s.finish?.();if(s.fail)throw new TypeError("Network unavailable");return s.response;}`;
    }
    return source ? { shortCircuit: true, url: `data:text/javascript,${encodeURIComponent(source)}` } : next(specifier, context);
  },
});
const { decide } = await import("./service.ts");
const saved = process.env.PLANWERK_DECISION_POLICIES;
after(() => { hooks.deregister(); db.close(); Reflect.deleteProperty(globalThis, "__decisionServiceTest"); });
afterEach(() => {
  if (saved === undefined) delete process.env.PLANWERK_DECISION_POLICIES;
  else process.env.PLANWERK_DECISION_POLICIES = saved;
  state.finish = undefined; state.fail = false;
});
function configure(validationId = "synthetic-only") {
  process.env.PLANWERK_DECISION_POLICIES = JSON.stringify({ risk: { mode: "active",
    acceptance: { minimumProbability: 0.95, minimumMargin: 0.8, validationId } } });
  state.calls = 0;
  db.exec("DELETE FROM decision_records");
}
const questions = { verdict: { type: "choice" as const, instructions: "Accept this synthetic example?",
  criteria: { pass: "Meets criteria", block: "Unresolved blocker" } } };

test("unchanged work shares inference and persisted decisions, while host partitions remain separate", async () => {
  configure();
  const options = { hostUrl: "host-a", owner: "card-a" };
  const [a, b] = await Promise.all([
    decide("risk", "synthetic-v1", "Synthetic", questions, options),
    decide("risk", "synthetic-v1", "Synthetic", questions, options),
  ]);
  assert.equal(a.kind, "accepted");
  assert.equal(a.key, b.key);
  assert.equal(state.calls, 1);
  assert.equal((await decide("risk", "synthetic-v1", "Synthetic", questions, options)).key, a.key);
  await decide("risk", "synthetic-v1", "Synthetic", questions, { ...options, hostUrl: "host-b" });
  assert.equal(state.calls, 2);
});

test("policy changes invalidate cached acceptance and fence in-flight results", async () => {
  configure();
  const first = await decide("risk", "synthetic-v1", "Synthetic", questions);
  process.env.PLANWERK_DECISION_POLICIES = JSON.stringify({ risk: { mode: "active",
    acceptance: { minimumProbability: 1, minimumMargin: 1, validationId: "stricter" } } });
  const second = await decide("risk", "synthetic-v1", "Synthetic", questions);
  assert.notEqual(first.key, second.key);
  assert.equal(second.kind, "needs-human");
  assert.equal(state.calls, 2);
  await decide("risk", "synthetic-v1", "Synthetic", questions);
  assert.equal(state.calls, 2, "abstention must not be rejudged every heartbeat");

  state.finish = async () => { delete process.env.PLANWERK_DECISION_POLICIES; };
  const changed = await decide("risk", "synthetic-v1", "New evidence", questions);
  assert.equal(changed.kind, "deferred");
  assert.match(changed.reason!, /policy changed/);
});

test("cancelling one observer does not cancel shared inference for another authorized caller", async () => {
  configure();
  let release!: () => void;
  state.finish = () => new Promise<void>((resolve) => { release = resolve; });
  const abort = new AbortController();
  const first = decide("risk", "synthetic-v1", "Synthetic", questions, { signal: abort.signal });
  const rejected = assert.rejects(first, /cancel|abort/i);
  const second = decide("risk", "synthetic-v1", "Synthetic", questions);
  await new Promise<void>((resolve) => setImmediate(resolve));
  abort.abort();
  release();
  await rejected;
  assert.equal((await second).kind, "accepted");
  assert.equal(state.calls, 1);
});

test("transient failures are explicit deferrals and never trigger immediate internal retries", async () => {
  configure();
  state.fail = true;
  const failure = await decide("risk", "synthetic-v1", "Synthetic", questions);
  assert.equal(failure.kind, "deferred");
  assert.equal(failure.response, undefined);
  assert.ok(failure.retryAt! > Date.now());
  await decide("risk", "synthetic-v1", "Synthetic", questions);
  assert.equal(state.calls, 1);
});

test("active mode without a validated profile abstains before inference", async () => {
  configure();
  process.env.PLANWERK_DECISION_POLICIES = JSON.stringify({ risk: { mode: "active" } });
  const result = await decide("risk", "synthetic-v1", "Synthetic", questions);
  assert.equal(result.kind, "needs-human");
  assert.match(result.reason!, /validated/);
  assert.equal(state.calls, 0);
});

test("reconciliation stops retrying after its per-evidence provider budget", async () => {
  configure();
  state.fail = true;
  let now = Date.now();
  const clock = mock.method(Date, "now", () => now);
  try {
    let result;
    for (let attempt = 0; attempt < 4; attempt++) {
      result = await decide("risk", "synthetic-v1", "Synthetic", questions);
      now += 31_000;
    }
    assert.equal(result!.kind, "needs-human");
    assert.equal(result!.attempts, 3);
    assert.equal(state.calls, 3);
  } finally { clock.mock.restore(); }
});
