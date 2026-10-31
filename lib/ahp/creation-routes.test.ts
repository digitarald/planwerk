import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test, beforeEach } from "node:test";
import { randomUUID } from "node:crypto";

const state = { creates: 0, resolutions: 0, outcome: "started", result: undefined as unknown };
Object.assign(globalThis, { __creationRoutesTest: state });
registerHooks({
  resolve(specifier, context, next) {
    let source: string | undefined;
    if (specifier === "server-only") source = "";
    if (specifier === "next/server") source = "export class NextRequest extends Request {get nextUrl(){return new URL(this.url)}}; export const NextResponse={json:(body,init)=>Response.json(body,init)}";
    if (specifier.endsWith("/session-config") || specifier === "./session-config") source = `export class CreationConfigError extends Error{}; export async function resolveCreationConfiguration(){globalThis.__creationRoutesTest.resolutions++;return {provider:'copilotcli'}}`;
    if (specifier.endsWith("/client-operation")) source = "export async function withAHPClient(h,fn){return fn({})}";
    if (specifier.endsWith("/task-creation")) source = `const s=globalThis.__creationRoutesTest;export async function runTaskCreation(input,emit){
      s.creates++;emit({type:'stage',stage:'creating'});emit({type:'progress',progress:{progressToken:input.requestId,progress:10}});
      const result={type:'result',outcome:s.outcome,resource:'copilotcli:/created',...(s.outcome==='started'?{}:{error:'Initial prompt failed'})};
      s.result=result;return result}`;
    if (specifier.endsWith("/types")) source = "export const shouldShowSession=()=>true";
    if (specifier.endsWith("/catalog")) source = "export async function listAllSessions(){return []}";
    if (specifier.endsWith("/endpoint")) source = "export async function connectInitializedAhpClient(){throw Error('not used')}";
    if (specifier.endsWith("/session-summary")) source = "export const mapSdkSessionSummary=value=>value";
    if (specifier.endsWith("/api-error")) source = "export function ahpErrorResponse(err){return Response.json({error:err.message},{status:502})}";
    if (source !== undefined) return { shortCircuit: true, url: `data:text/javascript,${encodeURIComponent(source)}` };
    if (specifier.startsWith("@/")) return next(new URL(`../../${specifier.slice(2)}.ts`, import.meta.url).href, context);
    if (specifier.startsWith(".") && !/\.(ts|js)$/.test(specifier)) return next(`${specifier}.ts`, context);
    return next(specifier, context);
  },
});
const { NextRequest } = await import("next/server");
const { POST } = await import("../../app/api/ahp/sessions/route.ts");
const { POST: configure } = await import("../../app/api/ahp/sessions/configuration/route.ts");
const body = () => ({ requestId: randomUUID(), hostUrl: "ws://localhost:9000", workingDirectory: "/workspace", prompt: "Build feature" });
function request(payload: unknown, headers: Record<string, string> = {}, raw = false) {
  return new NextRequest("http://localhost:3000/api/ahp/sessions", {
    method: "POST",
    headers: { host: "localhost:3000", origin: "http://localhost:3000", "content-type": "application/json", ...headers },
    body: raw ? String(payload) : JSON.stringify(payload),
  });
}
beforeEach(() => { state.creates = 0; state.resolutions = 0; state.outcome = "started"; state.result = undefined; });

test("creation and configuration routes enforce the existing local mutation boundary before host access", async () => {
  for (const handler of [POST, configure]) {
    const response = await handler(request(body(), { origin: "https://attacker.example" }));
    assert.equal(response.status, 403);
  }
  assert.equal(state.creates, 0); assert.equal(state.resolutions, 0);
});

test("malformed JSON and invalid task options return 400 without creation", async () => {
  assert.equal((await POST(request("{", {}, true))).status, 400);
  assert.equal((await POST(request({ ...body(), prompt: " " }))).status, 400);
  assert.equal((await POST(request({ ...body(), requestId: "bad" }))).status, 400);
  assert.equal(state.creates, 0);
});

test("creation stream emits actual progress and a recoverable partial result", async () => {
  state.outcome = "prompt-failed";
  const response = await POST(request(body(), { accept: "application/x-ndjson" }));
  assert.equal(response.headers.get("content-type"), "application/x-ndjson");
  assert.equal(response.headers.get("cache-control"), "no-store");
  const events = (await response.text()).trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(events.map((event) => event.type), ["stage", "progress", "result"]);
  assert.equal(events[1].progress.total, undefined);
  assert.equal(events[2].resource, "copilotcli:/created");
  assert.equal(events[2].outcome, "prompt-failed");
  assert.equal(state.creates, 1);
});

test("non-stream consumers receive non-success status and recovery identity", async () => {
  state.outcome = "creation-uncertain";
  const response = await POST(request(body()));
  assert.equal(response.status, 502);
  assert.equal((await response.json()).resource, "copilotcli:/created");
});

test("stream disconnect does not abandon or repeat the submitted creation", async () => {
  const response = await POST(request(body(), { accept: "application/x-ndjson" }));
  await response.body!.cancel();
  await Promise.resolve();
  assert.equal(state.creates, 1);
  assert.ok(state.result);
});

test("configuration route resolves on the server and rejects unsupported request fields", async () => {
  const { hostUrl, workingDirectory } = body();
  const input = { hostUrl, workingDirectory };
  assert.equal((await configure(request(input))).status, 200);
  assert.equal(state.resolutions, 1);
  assert.equal((await configure(request({ ...input, invented: true }))).status, 400);
  assert.equal(state.resolutions, 1);
});
