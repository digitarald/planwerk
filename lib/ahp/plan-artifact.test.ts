import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { AhpClient } from "@microsoft/agent-host-protocol/client";
import type { ChatState, SessionState } from "@microsoft/agent-host-protocol";
import { EvidenceCaptureBudget, EvidenceCaptureLimitError } from "./evidence-budget.ts";
import { hashPlanContent, isPlanReviewRequest, readPlanReviewInput } from "./plan-source.ts";

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") return { shortCircuit: true, url: "data:text/javascript,export {}" };
    if (specifier.startsWith(".") && !path.extname(specifier) && context.parentURL?.startsWith("file:")) {
      const candidate = fileURLToPath(new URL(`${specifier}.ts`, context.parentURL));
      if (existsSync(candidate)) return { shortCircuit: true, url: pathToFileURL(candidate).href };
    }
    return nextResolve(specifier, context);
  },
});
after(() => hooks.deregister());
const { fetchSessionPlan, verifyPlanEvidence } = await import("./plan-artifact.ts");
const sessionUri = "ahp-session:/12345678-1234-1234-1234-123456789abc";
const chatUri = "ahp-chat://parent/encoded-session";
const uri = "file:///host-owned/custom-home/sdk-conversation-not-ahp-id/plan.md";
const request = {
  id: "request-1", questions: [],
  _meta: { purpose: "planReview" },
  planReview: { answerQuestionId: "question-1", actions: [{ id: "interactive" }], planUri: uri, content: "Only a summary" },
};
const state = {
  inputNeeded: [{ kind: "chatInput", id: "opaque", chat: chatUri, request }],
} as unknown as SessionState;
const chat = {
  resource: chatUri, turns: [],
  activeTurn: { id: "writer-turn", responseParts: [{ kind: "inputRequest", request }] },
} as unknown as ChatState;

function client(content = "# Actual plan", encoding = "utf-8") {
  const reads: string[] = [];
  return {
    reads,
    value: {
      async request(method: string, params: { uri: string }) {
        assert.equal(method, "resourceRead");
        reads.push(params.uri);
        return { encoding, data: encoding === "base64" ? Buffer.from(content).toString("base64") : content };
      },
      async subscribe() {
        return { result: { snapshot: { resource: chatUri, state: chat } },
          subscription: { async close() {} } };
      },
      async unsubscribe() {},
    } as unknown as AhpClient,
  };
}

test("reads only the host-published parent resource with distinct SDK backing", async () => {
  const host = client();
  const plan = await fetchSessionPlan(host.value, sessionUri, state, undefined, chat);
  assert.equal(plan?.artifact.contentRef, "# Actual plan");
  assert.deepEqual(plan?.source, { sessionUri, uri, chatUri, turnId: "writer-turn", requestId: request.id });
  assert.deepEqual(host.reads, [uri]);
});

test("base64 Unicode plan bytes and exact whitespace survive capture", async () => {
  const content = "# Plan\n\n    \u00e9 = 1\n";
  const host = client(content, "base64");
  const plan = await fetchSessionPlan(host.value, sessionUri, state, undefined, chat);
  assert.equal(plan?.artifact.contentRef, content);
  assert.notEqual(hashPlanContent(content), hashPlanContent(content.replace("    ", "")));
});

test("missing, summary-only and ambiguous host evidence fail closed without guessed reads", async () => {
  const host = client();
  assert.equal(await fetchSessionPlan(host.value, sessionUri, { inputNeeded: [] } as unknown as SessionState), null);
  assert.equal(await fetchSessionPlan(host.value, "copilotcli:/legacy", state), null);
  const summaryOnly = { inputNeeded: [{ ...state.inputNeeded![0], request: {
    ...request, planReview: { ...request.planReview, planUri: undefined },
  } }] } as unknown as SessionState;
  await assert.rejects(fetchSessionPlan(host.value, sessionUri, summaryOnly), /complete plan resource/);
  await assert.rejects(fetchSessionPlan(host.value, sessionUri, {
    inputNeeded: [state.inputNeeded![0], state.inputNeeded![0]],
  } as unknown as SessionState), /More than one/);
  await assert.rejects(fetchSessionPlan(host.value, sessionUri, state, undefined,
    { ...chat, activeTurn: undefined } as ChatState), /turn is unavailable/);
  assert.deepEqual(host.reads, []);
});

test("denied resources are errors, not certified absence", async () => {
  const host = client();
  host.value.request = (async () => { throw new Error("Permission denied"); }) as AhpClient["request"];
  await assert.rejects(fetchSessionPlan(host.value, sessionUri, state, undefined, chat), /Permission denied/);
});

test("capture observes decoded byte limits without truncating the plan", async () => {
  const budget = new EvidenceCaptureBudget({ maxFiles: 1, maxDecodedBytes: 2, timeoutMs: 1_000 });
  try {
    await assert.rejects(fetchSessionPlan(client("long", "base64").value, sessionUri, state, budget, chat),
      (error) => error instanceof EvidenceCaptureLimitError && error.detail === "byte-limit");
  } finally { budget.dispose(); }
});

test("verification rejects changed content and stale original requests", async () => {
  const host = client();
  const plan = await fetchSessionPlan(host.value, sessionUri, state, undefined, chat);
  assert(plan);
  const evidence = { content: plan.artifact.contentRef!, changesetRef: hashPlanContent(plan.artifact.contentRef!), source: plan.source };
  const budget = new EvidenceCaptureBudget();
  try {
    await verifyPlanEvidence(host.value, state, evidence, budget);
    await assert.rejects(verifyPlanEvidence(client("# Changed").value, state, evidence, budget), /parent plan changed/);
    await assert.rejects(verifyPlanEvidence(host.value, { inputNeeded: [] } as unknown as SessionState, evidence, budget),
      /original plan request/);
  } finally { budget.dispose(); }
});

test("plan request classification uses host metadata, including unsupported requests", () => {
  assert.equal(isPlanReviewRequest(request), true);
  assert.equal(isPlanReviewRequest({ _meta: { purpose: "planReview" } }), true);
  assert.equal(isPlanReviewRequest({ questions: [{ options: [{ id: "autopilot" }] }] }), false);
  assert.equal(readPlanReviewInput({ _meta: { purpose: "planReview" } }), null);
  assert.deepEqual(readPlanReviewInput(request), { questionId: "question-1", actionIds: ["interactive"], planUri: uri });
});

test("completed parent plan remains discoverable and current after approval", async () => {
  const content = "# SDK / AHP adoption plan\n" + "x".repeat(19_950 - "# SDK / AHP adoption plan\n".length);
  const host = client(content);
  const completed = {
    ...chat, activeTurn: undefined,
    turns: [{ id: "writer-turn", responseParts: [{ kind: "inputRequest", request, response: "accept" }] }],
  } as unknown as ChatState;
  const idle = { defaultChat: chatUri, inputNeeded: [] } as unknown as SessionState;
  const plan = await fetchSessionPlan(host.value, sessionUri, idle, undefined, completed);
  assert(plan);
  assert.equal(plan.artifact.contentRef, content);
  assert.equal(plan.source.requestId, undefined);
  assert.deepEqual(plan.source, { sessionUri, uri, chatUri, turnId: "writer-turn", publishedRequestId: request.id });
  const subscribed = {
    ...host.value,
    async subscribe() { return {
    result: { snapshot: { resource: chatUri, state: completed } }, subscription: { async close() {} },
    }; },
  } as unknown as AhpClient;
  const budget = new EvidenceCaptureBudget();
  try {
    await verifyPlanEvidence(subscribed, idle, { content, changesetRef: hashPlanContent(content), source: plan.source }, budget);
    await assert.rejects(verifyPlanEvidence(subscribed, { ...idle, defaultChat: "ahp-chat:/other" },
      { content, changesetRef: hashPlanContent(content), source: plan.source }, budget), /original plan chat/);
    completed.turns.push({
      ...completed.turns[0], id: "new-writer-turn",
    });
    await assert.rejects(verifyPlanEvidence(subscribed, idle,
      { content, changesetRef: hashPlanContent(content), source: plan.source }, budget), /latest published parent plan/);
  } finally { budget.dispose(); }
});

test("a newer unpublished plan never falls back to an older published plan or a peer", async () => {
  const host = client();
  const history = {
    ...chat, activeTurn: undefined,
    turns: [
      { id: "old", responseParts: [{ kind: "inputRequest", request, response: "accept" }] },
      { id: "new", responseParts: [{ kind: "inputRequest", request: {
        ...request, id: "new-request", planReview: { ...request.planReview, planUri: undefined },
      }, response: "accept" }] },
    ],
  } as unknown as ChatState;
  await assert.rejects(fetchSessionPlan(host.value, sessionUri,
    { defaultChat: chatUri, inputNeeded: [] } as unknown as SessionState, undefined, history), /latest parent plan/);
  assert.deepEqual(host.reads, []);
});
