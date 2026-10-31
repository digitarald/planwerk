import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import type { NextRequest } from "next/server";
import { hashPlanContent } from "../../../../lib/ahp/plan-source.ts";

const db = new Database(":memory:");
db.exec("CREATE TABLE session_cache(session_uri TEXT PRIMARY KEY, host_url TEXT, summary_json TEXT, enrichment_json TEXT)");
const cardId = "ahp-session:/11111111-1111-4111-a111-111111111111";
const hostUrl = "ws://fake";
const ref = hashPlanContent("# Parent plan");
const binding = { sourceRevision: "source-a", planVersion: "version-a" };
db.prepare("INSERT INTO session_cache VALUES(?,?,?,?)").run(cardId, hostUrl,
  JSON.stringify({ resource: cardId, _planwerkRiskFacts: binding }),
  JSON.stringify({
    planContent: "# Parent plan", planContentHash: ref,
    planSource: { sessionUri: cardId, uri: "file:///host/plan.md" },
    _planwerkSource: binding,
  }));
const state = {
  db, started: true, fail: false, calls: [] as unknown[][],
  configDirectory: undefined as string | undefined,
};
const key = "__planReviewRouteTest";
Object.defineProperty(globalThis, key, { value: state, configurable: true });
const root = path.resolve(import.meta.dirname, "../../../..");
const mocks: Record<string, string> = {
  "server-only": "export {}",
  "next/server": "export class NextRequest extends Request {} export class NextResponse extends Response {static json(value, init){return Response.json(value,init)}}",
  "@/lib/db/schema": `export const getDb=()=>globalThis["${key}"].db`,
  "@/lib/db/session-cache": "export const getCachedSession=()=>({summary:{workingDirectory:'/project/nested'}})",
  "@/lib/orchestrator/risk-store": "export const getRiskForAutomation=()=> 'medium'",
  "@/lib/orchestrator/gate-engine": `
    export const getCardPhase=()=> 'build';
    export const getNextPhase=(phase)=>({define:'plan',plan:'build',build:'review',review:'ship'}[phase]??null)`,
  "@/lib/orchestrator/skill-config": `
    export function loadConfig(directory){globalThis["${key}"].configDirectory=directory;return {}}
    export const getApplicableSkills=(transition)=> transition==='plan->build'
      ? [{id:'product-plan-critic',prompt:'/rubber-duck',autoFix:false}] : []`,
  "@/lib/orchestrator/review-executor": `
    export const getReviewRunsForCard=()=>[];
    export async function startReview(...args){
      const s=globalThis["${key}"];s.calls.push(args);
      if(s.fail)throw new Error('Source changed before dispatch');
      return {success:true,reviewRunId:1,started:s.started}
    }`,
};
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (mocks[specifier]) return { shortCircuit: true, url: `data:text/javascript,${encodeURIComponent(mocks[specifier])}` };
    let candidate: string | undefined;
    if (specifier.startsWith("@/")) candidate = path.join(root, `${specifier.slice(2)}.ts`);
    else if (specifier.startsWith(".") && context.parentURL?.startsWith("file:")) {
      candidate = fileURLToPath(new URL(specifier, context.parentURL));
      if (!path.extname(candidate)) candidate += ".ts";
    }
    if (candidate && existsSync(candidate)) return { shortCircuit: true, url: pathToFileURL(candidate).href };
    return nextResolve(specifier, context);
  },
});
after(() => { hooks.deregister(); db.close(); Reflect.deleteProperty(globalThis, key); });
const { POST } = await import("./route.ts");
function request(overrides: Record<string, unknown> = {}): NextRequest {
  return new Request("http://localhost/api/orchestrator/review", {
    method: "POST",
    headers: { host: "localhost", origin: "http://localhost", "content-type": "application/json" },
    body: JSON.stringify({ cardId, sessionUri: cardId, hostUrl, skillId: "product-plan-critic",
      phaseTransition: "plan->build", ...overrides }),
  }) as NextRequest;
}

test("HTTP plan review resolves the requested transition, not persisted Build phase", async () => {
  const response = await POST(request());
  assert.equal(response.status, 200);
  const args = state.calls.at(-1)!;
  assert.equal(args[4], "plan->build");
  assert.equal(args[6], ref);
  assert.equal(state.configDirectory, "/project/nested");
  assert.equal((args[7] as { independent: boolean }).independent, true);
});

test("invalid transitions, unconfigured skills, wrong targets and stale revisions never dispatch", async () => {
  const before = state.calls.length;
  for (const overrides of [
    { phaseTransition: "ship->plan" }, { phaseTransition: "plan-to-build" },
    { skillId: "unknown" }, { sessionUri: "ahp-session:/other" },
    { changesetRef: "plan:old" },
  ]) {
    const response = await POST(request(overrides));
    assert([400, 409].includes(response.status));
  }
  assert.equal(state.calls.length, before);
});

test("reused review runs are not reported as new injected work", async () => {
  state.started = false;
  const response = await POST(request());
  const body = await response.json();
  assert.equal(body.status, "existing");
  assert.equal(body.startedAt, undefined);
  state.started = true;
});

test("source races produce an explicit HTTP error rather than an unhandled exception", async () => {
  state.fail = true;
  const response = await POST(request());
  assert.equal(response.status, 502);
  assert.match((await response.json()).error, /Source changed/);
  state.fail = false;
});
