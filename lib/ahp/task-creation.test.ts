import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test, beforeEach } from "node:test";
import { randomUUID } from "node:crypto";
import type { AgentInfo, ResolveSessionConfigResult, SessionConfigCompletionsParams } from "@microsoft/agent-host-protocol";
import { RpcError } from "@microsoft/agent-host-protocol/client";
import { configProblems, creationModelSchema, creationSummary } from "./creation-config.ts";

const copilot = {
  provider: "copilotcli", displayName: "Copilot", description: "",
  models: [
    { provider: "copilotcli", id: "good", name: "Good", configSchema: { type: "object", properties: { reasoning: { type: "string", title: "Reasoning", enum: ["low", "high"], default: "low" } } } },
    { provider: "copilotcli", id: "blocked", name: "Blocked", policyState: "disabled" },
  ],
} as AgentInfo;
const state = {
  agents: [copilot],
  creates: [] as Record<string, unknown>[],
  actions: [] as { message: { model?: unknown; text?: string }; type: string }[],
  completions: [] as SessionConfigCompletionsParams[],
  shutdowns: 0,
  failConnect: undefined as Error | undefined,
  failCreate: undefined as Error | undefined,
  failDispatch: undefined as Error | undefined,
  failPing: undefined as Error | undefined,
  progress: false,
  queued: false,
  noChat: false,
  resolve(config: Record<string, unknown> = {}): ResolveSessionConfigResult {
    return {
      schema: { type: "object", properties: {
        mode: { type: "string", title: "Mode", enum: ["interactive", "plan"] },
        autoApprove: { type: "string", title: "Approvals", enum: ["default", "assisted", "autoApprove"] },
        isolation: { type: "string", title: "Isolation", enum: ["folder", "worktree"] },
        ...(config.isolation === "worktree" ? { branch: { type: "string" as const, title: "Branch", enumDynamic: true, enum: ["main"] } } : {}),
      }, ...(config.isolation === "worktree" ? { required: ["branch"] } : {}) },
      values: { mode: "interactive", autoApprove: "default", isolation: "folder", ...config },
    };
  },
};
Object.assign(globalThis, { __taskCreationTest: state });
registerHooks({
  resolve(specifier, context, next) {
    let source: string | undefined;
    if (specifier === "server-only") source = "";
    if (specifier === "./snapshot") source = `const s=globalThis.__taskCreationTest;
      export async function readRootState(){return {agents:s.agents}}
      export async function readSessionState(){return {}}
      export async function withSessionState(c,id,fn){const state={defaultChat:s.noChat?undefined:'ahp-chat:/test',status:0};
        return fn(state,{assertCurrent(){},getState(){return state}})}`;
    if (specifier === "./endpoint") source = `const s=globalThis.__taskCreationTest;
      export async function connectInitializedAhpClient(host,options){
        if(s.failConnect)throw s.failConnect;
        return {client:{
          async request(method,params){
            if(method==='resolveSessionConfig')return s.resolve(params.config);
            if(method==='sessionConfigCompletions'){
              s.completions.push(params);return {items:['main','feature'].filter(v=>!params.query||v.includes(params.query)).map(value=>({value,label:value}))};
            }
            if(method==='createSession'){
              s.creates.push(params);
              if(s.progress){const wrapped=options.wrapTransport({send(){},close(){},async recv(){
                return {kind:'text',text:JSON.stringify({jsonrpc:'2.0',method:'progress',params:{channel:'ahp-root://',progressToken:params.progressToken,progress:5,message:'Downloading SDK'}})}
              }});await wrapped.recv();}
              if(s.failCreate)throw s.failCreate;
              return null;
            }
          },
          dispatch(channel,action){if(s.failDispatch)throw s.failDispatch;s.actions.push(action)},
          async ping(){if(s.failPing)throw s.failPing},
          async shutdown(){s.shutdowns++}
        }};
      }`;
    if (specifier === "./chat-facts") source = "export async function assertDefaultChatWritable(){}";
    if (specifier === "./types") source = "export function parseAHPStatus(){return {isInProgress:globalThis.__taskCreationTest.queued}}";
    if (source !== undefined) return { shortCircuit: true, url: `data:text/javascript,${encodeURIComponent(source)}` };
    if (specifier.startsWith(".") && !/\.(ts|js)$/.test(specifier)) return next(`${specifier}.ts`, context);
    return next(specifier, context);
  },
});
const { resolveCreationConfiguration, CreationConfigError } = await import("./session-config.ts");
const { parseCreationRequest } = await import("./creation-request.ts");
const { performTaskCreation, runTaskCreation, creationProgressTransport } = await import("./task-creation.ts");
const client = { request: async (method: string, params: Record<string, unknown>) => {
  if (method === "resolveSessionConfig") return state.resolve(params.config as Record<string, unknown>);
  state.completions.push(params as unknown as SessionConfigCompletionsParams);
  return { items: ["main", "feature"].filter((value) => !params.query || value.includes(String(params.query))).map((value) => ({ value, label: value })) };
} } as Parameters<typeof resolveCreationConfiguration>[0];
const initialResolve = state.resolve;
beforeEach(() => {
  state.agents = [copilot];
  state.creates = []; state.actions = []; state.completions = []; state.shutdowns = 0;
  state.failConnect = undefined; state.failCreate = undefined; state.failDispatch = undefined; state.failPing = undefined;
  state.progress = false; state.queued = false; state.noChat = false; state.resolve = initialResolve;
});
const base = () => ({ hostUrl: "ws://localhost:9000", workingDirectory: "file:///workspace", requestId: randomUUID(), prompt: "Build feature" });

test("duplicate Copilot effort aliases expose one authoritative picker without losing supported values", async () => {
  const effort = { type: "string" as const, title: "Effort Level", enum: ["low", "medium", "high", "xhigh", "max"] };
  const schema = { type: "object" as const, properties: {
    thinkingLevel: { ...effort, default: "medium" },
    reasoningEffort: effort,
    contextSize: { type: "number" as const, title: "Context Size", enum: [272000, 922000], default: 272000 },
  } };
  state.agents = [{ ...copilot, models: [{ ...copilot.models[0], configSchema: schema }] }];
  const resolved = await resolveCreationConfiguration(client, { ...base(), model: { id: "good" } });
  assert.deepEqual(Object.keys(resolved.providers[0].models[0].configSchema!.properties), ["thinkingLevel", "contextSize"]);
  assert.deepEqual(resolved.model?.config, { thinkingLevel: "medium", contextSize: 272000 });
  const max = await resolveCreationConfiguration(client, { ...base(), model: { id: "good", config: { thinkingLevel: "max", contextSize: 922000 } }, strict: true });
  assert.deepEqual(max.model?.config, { thinkingLevel: "max", contextSize: 922000 });
  const outcome = await runTaskCreation({ ...base(), config: max.values, model: max.model, revision: max.revision }, () => {});
  assert.equal(outcome.outcome, "started");
  assert.deepEqual(state.actions[0].message.model, max.model);
  await assert.rejects(resolveCreationConfiguration(client, {
    ...base(), model: { id: "good", config: { thinkingLevel: "medium", reasoningEffort: "high" } }, strict: true,
  }), /reasoningEffort is not supported/);
  assert.ok(schema.properties.reasoningEffort, "do not mutate the host advertisement");
  const different = creationModelSchema("copilotcli", { ...schema, properties: {
    ...schema.properties, reasoningEffort: { ...effort, enum: [...effort.enum, "ultra"] },
  } })!;
  assert.equal(different.properties.thinkingLevel.title, "Effort Level (thinkingLevel)");
  assert.equal(different.properties.reasoningEffort.title, "Effort Level (reasoningEffort)");
  assert.ok(different.properties.reasoningEffort.enum!.includes("ultra"));
  const other = creationModelSchema("other", schema)!;
  assert.ok(other.properties.reasoningEffort);
  assert.equal(other.properties.reasoningEffort.title, "Effort Level (reasoningEffort)");
});

test("Copilot defaults are supported, visible and configurable; provider semantics are not translated", async () => {
  const resolved = await resolveCreationConfiguration(client, base());
  assert.equal(resolved.values.mode, "plan");
  assert.equal(resolved.values.autoApprove, "autoApprove");
  assert.match(creationSummary(resolved), /Plan mode · approvals bypassed/);
  const approved = await resolveCreationConfiguration(client, { ...base(), config: { mode: "interactive", autoApprove: "assisted" } });
  assert.equal(approved.values.autoApprove, "assisted");
  assert.equal(approved.values.mode, "interactive");
  state.agents = [{ ...copilot, provider: "other", models: [] }];
  state.resolve = () => ({ schema: { type: "object", properties: { policy: { type: "string", title: "Permission policy", enum: ["ask"], default: "ask" } } }, values: { policy: "ask" } });
  const other = await resolveCreationConfiguration(client, base());
  assert.deepEqual(other.values, { policy: "ask" });
  assert.equal(other.provider, "other");
  await assert.rejects(resolveCreationConfiguration(client, { ...base(), provider: "copilotcli" }), CreationConfigError);
});

test("unsupported and read-only Copilot defaults are never forced", async () => {
  state.resolve = () => ({ schema: { type: "object", properties: {
    mode: { type: "string", title: "Mode", enum: ["interactive"] },
    autoApprove: { type: "string", title: "Approvals", enum: ["default", "autoApprove"], readOnly: true },
  } }, values: { mode: "interactive", autoApprove: "default" } });
  assert.deepEqual((await resolveCreationConfiguration(client, base())).values, { mode: "interactive", autoApprove: "default" });
  await assert.rejects(resolveCreationConfiguration(client, { ...base(), config: { autoApprove: "autoApprove" }, strict: true }), /changed/);
});

test("dependent schema, branch search and exact dynamic membership are resolved contextually", async () => {
  const branch = await resolveCreationConfiguration(client, { ...base(), config: { isolation: "worktree" } });
  assert.match(branch.problems.join(), /Branch is required/);
  const selected = await resolveCreationConfiguration(client, { ...base(), config: { isolation: "worktree", branch: "feature" }, completion: { property: "branch", query: "feat" } });
  assert.equal(selected.completions.branch[0].value, "feature");
  assert.ok(state.completions.every((params) => params.config?.isolation === "worktree"));
  const strict = await resolveCreationConfiguration(client, { ...base(), config: selected.values, strict: true });
  assert.equal(strict.revision, selected.revision);
  await assert.rejects(resolveCreationConfiguration(client, { ...base(), config: { isolation: "worktree", branch: "gone" }, strict: true }), /no longer available/);
  const folder = await resolveCreationConfiguration(client, { ...base(), config: { isolation: "folder", branch: "main" } });
  assert.equal(folder.values.branch, undefined);
  await assert.rejects(resolveCreationConfiguration(client, { ...base(), config: { isolation: "folder", branch: "main" }, strict: true }), /not supported/);
});

test("models use advertised config metadata and disabled/invalid model choices are rejected", async () => {
  const resolved = await resolveCreationConfiguration(client, { ...base(), model: { id: "good" } });
  assert.deepEqual(resolved.model, { id: "good", config: { reasoning: "low" } });
  await assert.rejects(resolveCreationConfiguration(client, { ...base(), model: { id: "blocked" } }), /disabled/);
  await assert.rejects(resolveCreationConfiguration(client, { ...base(), model: { id: "gone" } }), /unavailable/);
  await assert.rejects(resolveCreationConfiguration(client, { ...base(), model: { id: "good", config: { reasoning: "invalid" } }, strict: true }), /allowed value/);
  assert.match(configProblems({ type: "object", properties: { count: { type: "number", title: "Count" } } }, { count: "10", unknown: true }).join(), /Expected number.*not supported/);
});

test("creation uses current values, unique progress token, and model on the first message without claiming ownership", async () => {
  const input = base();
  const resolved = await resolveCreationConfiguration(client, { ...input, model: { id: "good", config: { reasoning: "high" } } });
  const events: string[] = [];
  const result = await performTaskCreation({ ...input, provider: resolved.provider, config: resolved.values, model: resolved.model, revision: resolved.revision }, (event) => events.push(event.type === "stage" ? event.stage : event.type));
  assert.equal(result.outcome, "started");
  assert.equal(result.resource, `ahp-session:/${input.requestId}`);
  assert.deepEqual(state.creates[0].config, resolved.values);
  assert.deepEqual(state.creates[0].workingDirectories, ["file:///workspace"]);
  assert.equal(state.creates[0].activeClient, undefined);
  assert.equal(state.creates[0].model, undefined);
  assert.match(String(state.creates[0].progressToken), /^[a-f0-9-]{36}$/);
  assert.deepEqual(state.actions[0].message.model, resolved.model);
  assert.deepEqual(events, ["connecting", "validating", "creating", "sending"]);
  assert.equal(state.shutdowns, 1);
});

test("stale configuration rejects before creation and never silently changes approvals", async () => {
  const input = base();
  const resolved = await resolveCreationConfiguration(client, input);
  state.resolve = () => ({ schema: { type: "object", properties: { mode: { type: "string", title: "Mode", enum: ["plan"] }, autoApprove: { type: "string", title: "Approvals", enum: ["default"] } } }, values: { mode: "plan", autoApprove: "default" } });
  const result = await performTaskCreation({ ...input, config: resolved.values, revision: resolved.revision }, () => {});
  assert.equal(result.outcome, "invalid");
  assert.equal(state.creates.length, 0);
});

test("schema-only staleness rejects before creation even when values remain valid", async () => {
  const input = base();
  const resolved = await resolveCreationConfiguration(client, input);
  state.resolve = (config) => {
    const next = initialResolve(config);
    next.schema.properties.mode.enumLabels = ["Interactive", "Plan"];
    return next;
  };
  const result = await performTaskCreation({ ...input, config: resolved.values, revision: resolved.revision }, () => {});
  assert.equal(result.outcome, "invalid");
  assert.match(result.error!, /changed on the host/);
  assert.equal(state.creates.length, 0);
});

test("concurrent duplicate submission and replay dispatch once; changed payload is rejected", async () => {
  const input = base();
  const results = await Promise.all([runTaskCreation(input, () => {}), runTaskCreation(input, () => {})]);
  assert.deepEqual(results[0], results[1]);
  await runTaskCreation(input, () => {});
  assert.equal(state.creates.length, 1);
  assert.equal(state.actions.length, 1);
  assert.throws(() => runTaskCreation({ ...input, prompt: "Changed" }, () => {}), /different options/);
});

test("partial creation retains its resource and classifies failed versus uncertain initial delivery", async () => {
  state.noChat = true;
  const noChat = await performTaskCreation(base(), () => {});
  assert.equal(noChat.outcome, "prompt-failed"); assert.ok(noChat.resource);
  state.noChat = false; state.failDispatch = new Error("Chat denied");
  assert.equal((await performTaskCreation(base(), () => {})).outcome, "prompt-failed");
  state.failDispatch = undefined; state.failPing = new Error("Connection lost");
  const uncertain = await performTaskCreation(base(), () => {});
  assert.equal(uncertain.outcome, "prompt-uncertain"); assert.ok(uncertain.resource);
});

test("unknown creation is never retried; provider setup failures and host rejection are distinct", async () => {
  const input = base();
  state.failCreate = new Error("Connection lost");
  assert.equal((await runTaskCreation(input, () => {})).outcome, "creation-uncertain");
  await runTaskCreation(input, () => {});
  assert.equal(state.creates.length, 1); assert.equal(state.actions.length, 0);
  state.failCreate = new RpcError(-32002, "Provider setup failed");
  state.progress = true;
  const events: string[] = [];
  assert.equal((await performTaskCreation(base(), (event) => events.push(event.type))).outcome, "setup-failed");
  assert.ok(events.includes("progress"));
  state.progress = false;
  assert.equal((await performTaskCreation(base(), () => {})).outcome, "creation-failed");
  state.failConnect = new Error("Host unavailable");
  assert.equal((await performTaskCreation(base(), () => {})).outcome, "setup-failed");
});

test("an existing session is recoverable after process-local attempt history is lost", async () => {
  state.failCreate = new RpcError(-32003, "Session already exists");
  const result = await performTaskCreation(base(), () => {});
  assert.equal(result.outcome, "creation-uncertain");
  assert.ok(result.resource);
  assert.equal(state.actions.length, 0);
});

test("progress observation preserves frames, ignores unrelated tokens and accepts indeterminate progress", async () => {
  const events: unknown[] = [];
  const frames = [
    { kind: "text" as const, text: JSON.stringify({ method: "progress", params: { progressToken: "other", progress: 5 } }) },
    { kind: "text" as const, text: JSON.stringify({ method: "progress", params: { progressToken: "ours", progress: 5 } }) },
    { kind: "text" as const, text: "invalid JSON" },
  ];
  let index = 0;
  const wrapped = creationProgressTransport({ send() {}, close() {}, async recv() { return frames[index++] ?? null; } }, "ours", (event) => events.push(event));
  for (const frame of frames) assert.equal(await wrapped.recv(), frame);
  assert.equal(events.length, 1);
});

test("queued delivery is reported as queued, not started", async () => {
  state.queued = true;
  assert.equal((await performTaskCreation(base(), () => {})).outcome, "queued");
  assert.equal(state.actions[0].type, "chat/pendingMessageSet");
});

test("a nonblank fallback title is sent when the prompt is blank", async () => {
  const input = { ...base(), prompt: " ", title: "Fallback task" };
  parseCreationRequest(input, true);
  assert.equal((await performTaskCreation(input, () => {})).outcome, "started");
  assert.equal(state.actions[0].message.text, "Fallback task");
});

test("request parsing rejects malformed or remote input and normalizes a workspace path", () => {
  const input = base();
  assert.equal(parseCreationRequest({ ...input, workingDirectory: "/workspace" }, true).workingDirectory, "file:///workspace");
  assert.throws(() => parseCreationRequest({ ...input, workingDirectory: "https://remote/folder" }, true), /local folder/);
  assert.throws(() => parseCreationRequest({ ...input, requestId: "bad" }, true), /Invalid task options/);
  assert.throws(() => parseCreationRequest({ ...input, prompt: " " }, true), /Task description/);
});
