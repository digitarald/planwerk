import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";
import { OperationAdmission } from "../orchestrator/operation-admission.ts";
import { assertOperationCurrent, runOperationEffect, withOperationContext } from "../orchestrator/operation-context.ts";

const state = {
  creates: [] as Record<string, unknown>[], messages: 0, current: true, failCreate: false,
  assert: assertOperationCurrent, effect: runOperationEffect,
};
Object.assign(globalThis, { __createSessionTest: state });
registerHooks({
  resolve(specifier, context, next) {
    let source: string | undefined;
    if (specifier === "./client-operation") source = `export async function withAHPClient(h,fn){return fn({
      async request(method,args){s.creates.push(args);if(s.failCreate)throw Error('transport failed after create')}
    })}`;
    if (specifier === "./session-messenger") source = `export async function injectMessageWithClient(c,id,text,signal,before){
      s.assert('interact');before?.({chatUri:'chat',turnId:'message',queued:false,disposablePeerChat:false});
      await s.effect('interact',async()=>{s.messages++});
      return {success:true,chatUri:'chat',turnId:'message'}
    }`;
    if (source !== undefined) return { shortCircuit: true, url: `data:text/javascript,${encodeURIComponent("const s=globalThis.__createSessionTest;" + source)}` };
    if (specifier.startsWith(".") && !specifier.endsWith(".ts")) return next(`${specifier}.ts`, context);
    return next(specifier, context);
  },
});
const { createAndStartSession } = await import("./create-session.ts");
function admitted(operation: () => Promise<unknown>) {
  const lease = new OperationAdmission().acquire("host", "copilotcli:/reserved")!;
  return withOperationContext({
    hostUrl: "host", cardId: "copilotcli:/reserved", signal: new AbortController().signal,
    isCurrent: () => state.current, lease,
  }, operation).finally(() => lease.finish());
}

test("shared create/start uses the actual reserved AHP resource and plan-first config", async () => {
  let recorded = false;
  const result = await admitted(() => createAndStartSession({
    hostUrl: "host", resource: "copilotcli:/reserved", task: "Build feature", workingDirectory: "/workspace",
    beforeDispatch: (identity) => { recorded = true; assert.equal(identity.chatUri, "chat"); assert.equal(state.messages, 0); },
  }));
  assert.deepEqual(state.creates[0], {
    channel: "copilotcli:/reserved", provider: "copilotcli", workingDirectories: ["/workspace"],
    config: { mode: "plan", autoApprove: "autoApprove" },
  });
  assert.equal(recorded, true);
  assert.deepEqual(result, { resource: "copilotcli:/reserved", success: true, chatUri: "chat", turnId: "message" });
});

test("authority lost after create prevents its first instruction; partial create is surfaced", async () => {
  const before = state.messages;
  await assert.rejects(() => admitted(() => createAndStartSession({
    hostUrl: "host", resource: "copilotcli:/reserved", task: "Build feature",
    beforeStart: () => { state.current = false; },
  })), /cancelled/i);
  assert.equal(state.messages, before);
  state.current = true;
  state.failCreate = true;
  await assert.rejects(() => admitted(() => createAndStartSession({
    hostUrl: "host", resource: "copilotcli:/reserved", task: "Build feature",
  })), /transport failed after create/);
  assert.equal(state.messages, before);
});
