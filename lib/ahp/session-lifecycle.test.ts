import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Subscription, type AhpClient, type SubscriptionEvent } from "@microsoft/agent-host-protocol/client";
import type { ChatState, ChangesetState, SessionState, Snapshot, StateAction } from "@microsoft/agent-host-protocol";
import type { NextRequest } from "next/server";
import type { SessionStateAccess } from "./snapshot.ts";
import { AHPStatus } from "./types.ts";
import { awaitAbortable, OperationAbortedError } from "../abort.ts";
import { OperationAdmission } from "../orchestrator/operation-admission.ts";
import { withOperationContext } from "../orchestrator/operation-context.ts";
import { coordinatorModeAllows, type CoordinatorMode } from "../orchestrator/coordinator-mode.ts";
import { hashPlanContent } from "./plan-source.ts";
import { EvidenceCaptureBudget } from "./evidence-budget.ts";

const uri = "ahp-session:/12345678-1234-1234-1234-123456789abc";
const chatUri = "ahp-chat:/lifecycle";
const changesetUri = "ahp-changeset:/lifecycle";
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

function eventStream() {
  const queued: SubscriptionEvent[] = [];
  let pending: ((value: IteratorResult<SubscriptionEvent>) => void) | undefined;
  let closed = false;
  return {
    push(event: SubscriptionEvent) {
      if (closed) return;
      if (pending) {
        const done = pending;
        pending = undefined;
        done({ done: false, value: event });
      } else queued.push(event);
    },
    iterator: {
      async next(): Promise<IteratorResult<SubscriptionEvent>> {
        if (closed) return { done: true, value: undefined };
        if (queued.length) return { done: false, value: queued.shift()! };
        return new Promise((resolve) => { pending = resolve; });
      },
      async return() {
        closed = true;
        pending?.({ done: true, value: undefined });
        return { done: true as const, value: undefined };
      },
      [Symbol.asyncIterator]() { return this; },
    },
  };
}

function harness() {
  const streams = new Map<string, ReturnType<typeof eventStream>>();
  const resident = new Set<string>();
  const reads: string[] = [];
  const releases: string[] = [];
  const actions: { channel: string; action: StateAction }[] = [];
  const requests: string[] = [];
  const session: SessionState = {
    provider: "copilotcli", title: "Lifecycle", status: AHPStatus.Idle,
    lifecycle: "ready" as SessionState["lifecycle"], chats: [], activeClients: [],
    config: { schema: { type: "object", properties: {} }, values: {} },
    defaultChat: chatUri, inputNeeded: [],
    changesets: [{ uriTemplate: changesetUri, label: "Changes", changeKind: "session", capabilities: { review: {} } }] as SessionState["changesets"],
  };
  const chat = {
    resource: chatUri, status: AHPStatus.Idle, turns: [],
    modifiedAt: "2026-10-16T00:00:00Z",
  } as unknown as ChatState;
  const changeset: ChangesetState = {
    status: "ready" as ChangesetState["status"],
    files: [{ id: "a", edit: { after: { uri: "file:///a", content: { uri: "file:///a" } } } }],
  };
  const h = {
    session, chat, changeset, reads, releases, actions, requests, resident,
    missing: false,
    echo: true,
    shutdowns: 0,
    cleanupError: undefined as Error | undefined,
    cleanupWait: undefined as Promise<void> | undefined,
    onDispatch: undefined as ((channel: string, action: StateAction) => void) | undefined,
    onRead: undefined as ((resource: string) => Promise<void>) | undefined,
    onRequest: undefined as ((method: string) => Promise<void>) | undefined,
    ping: async () => {},
    push(channel: string, action: StateAction) {
      streams.get(channel)?.push({
        type: "action",
        params: { channel, action, serverSeq: 1 },
      } as SubscriptionEvent);
    },
    async end(channel: string) {
      await streams.get(channel)?.iterator.return();
    },
    client: undefined as unknown as AhpClient,
  };
  h.client = {
    async subscribe(resource: string) {
      if (resource !== uri) assert.equal(resident.has(uri), true, "dependent read must retain the session");
      assert.equal(resident.has(resource), false, "one subscription per channel per operation");
      reads.push(resource);
      resident.add(resource);
      const stream = eventStream();
      streams.set(resource, stream);
      const state = resource === uri ? session
        : resource.startsWith("ahp-chat:") ? {
          ...chat, resource, activeTurn: resource === chatUri ? chat.activeTurn : undefined,
        }
          : resource === changesetUri ? changeset
            : { agents: [{ provider: "copilotcli", capabilities: { multipleChats: {} } }] };
      await h.onRead?.(resource);
      return {
        result: { snapshot: h.missing && resource === uri
          ? undefined : { resource, state: structuredClone(state), fromSeq: 0 } as Snapshot },
        subscription: new Subscription(resource, {
          ...stream.iterator,
          async return() {
            await stream.iterator.return();
            if (resource === uri) await h.cleanupWait;
            if (h.cleanupError) throw h.cleanupError;
            return { done: true as const, value: undefined };
          },
        }),
      };
    },
    async unsubscribe(resource: string) {
      releases.push(resource);
      resident.delete(resource);
      if (resource === uri) await h.cleanupWait;
      if (h.cleanupError) throw h.cleanupError;
    },
    async request(method: string) {
      assert.equal(resident.has(uri), true, "peer chat work must retain the session");
      requests.push(method);
      await h.onRequest?.(method);
      return {};
    },
    dispatch(channel: string, action: StateAction) {
      assert.equal(resident.has(uri), true, "dispatch must retain the session");
      actions.push({ channel, action });
      h.onDispatch?.(channel, action);
      if (!h.echo) return;
      if (action.type === "chat/inputCompleted") {
        h.push(uri, { type: "session/inputNeededRemoved", id: "input:1" } as StateAction);
      } else if (action.type === "chat/toolCallConfirmed") {
        h.push(uri, { type: "session/inputNeededRemoved", id: "tool:1" } as StateAction);
      } else if (channel === uri || channel.startsWith("ahp-chat:") || channel === changesetUri) {
        h.push(channel, action);
      }
    },
    ping: () => h.ping(),
    async shutdown() {
      h.shutdowns++;
      for (const stream of streams.values()) await stream.iterator.return();
    },
  } as unknown as AhpClient;
  return h;
}

let active = harness();
const key = "__planwerkSessionLifecycleTest";
Object.defineProperty(globalThis, key, { get: () => active, configurable: true });
const root = path.resolve(import.meta.dirname, "../..");
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    let source: string | undefined;
    if (specifier === "server-only") source = "export {}";
    if (specifier === "./endpoint") source = `export async function connectInitializedAhpClient() {
      return { client: globalThis["${key}"].client };
    }`;
    if (specifier === "next/server") source = `
      export class NextRequest extends Request {}
      export class NextResponse extends Response {
        static json(value, init) { return Response.json(value, init); }
      }`;
    if (specifier === "@/lib/ahp/changeset-enricher") source = `
      export function findSessionChangeset(changesets) { return changesets[0]; }`;
    if (source) return { shortCircuit: true, url: `data:text/javascript,${encodeURIComponent(source)}` };
    if (specifier.startsWith("@/")) {
      return { shortCircuit: true, url: pathToFileURL(path.join(root, `${specifier.slice(2)}.ts`)).href };
    }
    if (specifier.startsWith(".") && !path.extname(specifier) && context.parentURL?.startsWith("file:")) {
      const candidate = fileURLToPath(new URL(`${specifier}.ts`, context.parentURL));
      if (existsSync(candidate)) return { shortCircuit: true, url: pathToFileURL(candidate).href };
    }
    return nextResolve(specifier, context);
  },
});
after(() => { hooks.deregister(); Reflect.deleteProperty(globalThis, key); });

const { withSessionState } = await import("./snapshot.ts");
const { answerInput, answerInputWithClient, injectMessage, injectMessageWithClient, setSessionArchived, startPeerChatReview, verifyPlanReviewSource, fetchChatTurnById } = await import("./session-messenger.ts");
const { readReviewSourceDigest } = await import("./changeset-enricher.ts");
const { fetchSessionDetails, resumeErroredTurn } = await import("./session-details.ts");
const { MessageDispatchAmbiguousError } = await import("./dispatch-confirmation.ts");
const { POST: inputRoute } = await import("../../app/api/ahp/sessions/input/route.ts");
const { POST: reviewRoute } = await import("../../app/api/ahp/sessions/review/route.ts");

function pendingInput() {
  return {
    kind: "chatInput", id: "input:1", chat: "ahp-chat:/owning-input",
    request: { id: "request:1", questions: [] },
  } as unknown as NonNullable<SessionState["inputNeeded"]>[number];
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function ownedOperation() {
  const admission = new OperationAdmission();
  const lease = admission.acquire("ws://fake", uri)!;
  const controller = new AbortController();
  const authority = { mode: "coordinate" as CoordinatorMode, source: "facts-1", scoped: true };
  const context = {
    signal: controller.signal,
    hostUrl: "ws://fake",
    cardId: uri,
    lease,
    isCurrent: (capability: Parameters<typeof coordinatorModeAllows>[1]) =>
      authority.source === "facts-1" && authority.scoped &&
      coordinatorModeAllows(authority.mode, capability),
  };
  return { admission, lease, controller, authority, context };
}

function request(body: object, signal?: AbortSignal): NextRequest {
  return new Request("http://localhost/api/ahp/sessions/input", {
    method: "POST", signal,
    headers: { host: "localhost", origin: "http://localhost", "content-type": "application/json" },
    body: JSON.stringify({ hostUrl: "ws://fake", sessionUri: uri, ...body }),
  }) as NextRequest;
}

test("retained session access reduces host actions and survives a wait timeout without reattaching", async () => {
  active = harness();
  await withSessionState(active.client, uri, async (initial, access) => {
    assert.equal(initial?.lifecycle, "ready");
    assert.equal(await access.waitFor((state) => state?.title === "Renamed", 1), false);
    active.push(uri, { type: "session/titleChanged", title: "Renamed" } as StateAction);
    assert.equal(await access.waitFor((state) => state?.title === "Renamed", 100), true);
    assert.equal(access.getState()?.title, "Renamed");
    assert.deepEqual(active.releases, []);
  });
  assert.deepEqual(active.reads, [uri]);
  assert.deepEqual(active.releases, [uri]);
});

test("scope cleanup stops and fences a drain whose SDK-style detached next never wakes", async () => {
  for (const outcome of ["success", "error", "abort"]) {
    let detached = false;
    let closes = 0;
    let unsubscribes = 0;
    let nextCalls = 0;
    let nextSettled = false;
    let finishNext!: (value: IteratorResult<SubscriptionEvent>) => void;
    const pending = new Promise<IteratorResult<SubscriptionEvent>>((resolve) => { finishNext = resolve; });
    void pending.then(() => { nextSettled = true; });
    const iterator: AsyncIterableIterator<SubscriptionEvent> = {
      next() { nextCalls++; return pending; },
      async return() {
        detached = true;
        closes++;
        // Like the SDK queue, detaching does not settle the parked next().
        return { done: true, value: undefined };
      },
      [Symbol.asyncIterator]() { return this; },
    };
    const client = {
      async subscribe() {
        return {
          result: { snapshot: { resource: uri, state: active.session, fromSeq: 0 } as Snapshot },
          subscription: new Subscription(uri, iterator),
        };
      },
      async unsubscribe() {
        unsubscribes++;
        // Queue close can wake attached readers, but not a detached cursor.
        if (!detached) finishNext({ done: true, value: undefined });
      },
    } as unknown as AhpClient;
    const controller = new AbortController();
    const failure = new Error("scope failure");
    let access!: SessionStateAccess;
    const operation = withSessionState(client, uri, async (_state, current) => {
      access = current;
      await tick();
      if (outcome === "error") throw failure;
      if (outcome === "abort") {
        controller.abort();
        await current.waitFor(() => false, 100);
      }
      return "confirmed";
    }, controller.signal);

    if (outcome === "error") await assert.rejects(operation, (error) => error === failure);
    else if (outcome === "abort") await assert.rejects(operation, { name: "AbortError" });
    else assert.equal(await operation, "confirmed");
    assert.equal(nextSettled, false, "closing the detached SDK reader must not wake next()");
    assert.equal(closes, 1);
    assert.equal(unsubscribes, 1);
    assert.equal(await access.waitFor(() => false, 100, new AbortController().signal), false);

    const title = access.getState()?.title;
    // Probe a late completion of the abandoned next(). A still-suspended
    // for-await loop would wake and invoke return() a second time here.
    finishNext({
      done: false,
      value: { type: "action", params: {
        channel: uri, serverSeq: 1,
        action: { type: "session/titleChanged", title: "Too late" },
      } } as SubscriptionEvent,
    });
    await tick();
    assert.equal(closes, 1, "the drain must already have exited before channel release");
    assert.equal(nextCalls, 1, "the stopped drain must never issue another read");
    assert.equal(access.getState()?.title, title, "late actions cannot mutate released state");
  }
});

test("explicit cold sends retain the session through writable checks and preserve queueing", async () => {
  for (const status of [AHPStatus.Idle, AHPStatus.InProgress]) {
    active = harness();
    active.session.status = status;
    const sent = await injectMessageWithClient(active.client, uri, "Continue");
    assert.equal(sent.success, true);
    assert.equal(sent.queued, status === AHPStatus.InProgress ? true : undefined);
    assert.equal(active.actions[0]?.action.type, status === AHPStatus.InProgress
      ? "chat/pendingMessageSet" : "chat/turnStarted");
    assert.deepEqual(active.reads, [uri, chatUri]);
    assert.equal(active.releases.at(-1), uri);
  }
});

test("details and verified resume retain session and chat without confirmation polling", async () => {
  active = harness();
  active.chat.turns = [{
    id: "turn:1", state: "error", message: { text: "Continue" },
    responseParts: [{ kind: "error", resumable: true, error: { errorType: "test", message: "Retry" } }],
  }] as unknown as ChatState["turns"];
  const details = await fetchSessionDetails("ws://fake", uri);
  assert.equal(details.runtimeError?.turnId, "turn:1");
  assert.deepEqual(active.reads, [uri, chatUri]);
  active.reads.length = 0;
  const stale = await resumeErroredTurn("ws://fake", uri, chatUri, "wrong");
  assert.equal(stale.success, false);
  assert.equal(active.actions.length, 0);
  active.reads.length = 0;
  const resumed = await resumeErroredTurn("ws://fake", uri, chatUri, "turn:1");
  assert.equal(resumed.success, true);
  assert.deepEqual(active.reads, [uri, chatUri]);
  assert.equal(active.actions[0]?.action.type, "chat/turnResume");
});

test("resume cannot report success without the authoritative chat changing", async () => {
  active = harness();
  active.chat.turns = [{
    id: "turn:1", state: "error", message: { text: "Continue" },
    responseParts: [{ kind: "error", resumable: true, error: { errorType: "test", message: "Retry" } }],
  }] as unknown as ChatState["turns"];
  active.echo = false;
  active.onDispatch = () => { void active.end(chatUri); };
  const result = await resumeErroredTurn("ws://fake", uri, chatUri, "turn:1");
  assert.equal(result.success, false);
  if (!result.success) assert.equal(result.reason, "not-applied");
  assert.deepEqual(active.reads, [uri, chatUri]);
});

test("peer review retains its session through capability read, peer creation and dispatch", async () => {
  active = harness();
  active.session.inputNeeded = [pendingInput()];
  const started = await startPeerChatReview("ws://fake", uri, "request:1", "/review");
  assert.equal(started.success, true);
  assert.deepEqual(active.requests, ["createChat"]);
  assert.deepEqual(active.reads, [uri, "ahp-root://", started.chatUri]);
  assert.equal(active.releases.at(-1), uri);
});

test("parent plan and source bytes are verified, with identities reserved before peer creation", async () => {
  active = harness();
  const content = "# Parent plan\nDo the work.";
  const planUri = "file:///host/sdk-writer/plan.md";
  const request = {
    id: "plan-request", questions: [],
    planReview: { answerQuestionId: "choice", actions: [{ id: "interactive" }], planUri },
  };
  active.session.inputNeeded = [{ kind: "chatInput", id: "opaque", chat: chatUri, request }] as unknown as SessionState["inputNeeded"];
  active.chat.activeTurn = { id: "writer-turn", responseParts: [{ kind: "inputRequest", request }] } as unknown as ChatState["activeTurn"];
  let code = "const before = 1;";
  const originalRequest = active.client.request;
  active.client.request = (async (method: string, params: { uri?: string }) => {
    if (method === "resourceRead") {
      return { encoding: "utf-8", data: params.uri === planUri ? content : code };
    }
    return originalRequest(method as never, params as never);
  }) as AhpClient["request"];
  let reserved: { sourceDigest?: string; chatUri: string; turnId: string } | undefined;
  active.onRequest = async (method) => {
    if (method === "createChat") assert(reserved?.sourceDigest, "reservation must precede createChat");
  };
  const evidence = {
    content, changesetRef: hashPlanContent(content),
    source: { sessionUri: uri, uri: planUri, chatUri, turnId: "writer-turn", requestId: request.id },
  };
  const started = await startPeerChatReview("ws://fake", uri, request.id, "/rubber-duck supplied plan", {
    plan: evidence,
    beforeDispatch(identity) { reserved = identity; },
  });
  assert.equal(started.success, true);
  assert.equal(started.chatUri, reserved?.chatUri);
  assert.equal(started.turnId, reserved?.turnId);
  assert(reserved?.sourceDigest);
  await verifyPlanReviewSource("ws://fake", uri, evidence, reserved.sourceDigest);
  // No edit-tool event: a shell can change bytes while all diff counts stay equal.
  code = "const after_ = 2;";
  await assert.rejects(verifyPlanReviewSource("ws://fake", uri, evidence, reserved.sourceDigest),
    /Source bytes changed/);
});

test("missing report-only source evidence prevents peer creation", async () => {
  active = harness();
  active.session.changesets = [];
  const budget = new EvidenceCaptureBudget();
  try {
    await withSessionState(active.client, uri, async (state) => {
      await assert.rejects(readReviewSourceDigest(active.client, uri, state!, budget), /changeset is required/);
    });

    assert.deepEqual(active.requests, []);
  } finally { budget.dispose(); }
});

test("a completed review turn is not ready while its background work can still mutate source", async () => {
  for (const busy of [true, false]) {
    active = harness();
    active.chat.turns = [{ id: "review-turn", state: "complete", responseParts: [] }] as unknown as ChatState["turns"];
    active.chat.backgroundWork = busy ? [{ id: "shell", label: "Running command" }] as unknown as ChatState["backgroundWork"] : [];
    await withSessionState(active.client, uri, async () => {
      const turn = await fetchChatTurnById("ws://fake", chatUri, "review-turn");
      assert.equal(Boolean(turn), !busy);
    });
  }
});

for (const change of ["mode", "source", "scope"] as const) {
  test(`owned input rechecks ${change} after state acquisition and dispatches nothing when revoked`, async () => {
    active = harness();
    active.session.inputNeeded = [pendingInput()];
    const { authority, context, lease, admission } = ownedOperation();
    const acquired = deferred();
    const release = deferred();
    active.onRead = async (resource) => {
      if (resource === uri) {
        acquired.resolve();
        await release.promise;
      }

    };
    const operation = withOperationContext(context, () =>
      answerInput("ws://fake", uri, "request:1", "accept"));
    await acquired.promise;
    if (change === "mode") authority.mode = "verify";
    if (change === "source") authority.source = "facts-2";
    if (change === "scope") authority.scoped = false;
    release.resolve();
    await assert.rejects(operation, OperationAbortedError);
    assert.deepEqual(active.actions, []);
    lease.finish();
    const replacement = admission.acquire("ws://fake", uri);
    assert.ok(replacement, "no remote effect was attempted, so admission remains retryable");
    replacement.finish();
  });
}

test("owned messenger operations cannot dispatch to a different host or session than admission", async () => {
  active = harness();
  const { context, lease } = ownedOperation();
  for (const [hostUrl, sessionUri] of [["ws://wrong", uri], ["ws://fake", "copilotcli:/wrong"]]) {
    await assert.rejects(async () => withOperationContext(context, () =>
      answerInput(hostUrl, sessionUri, "request:1", "accept")), OperationAbortedError);
    await assert.rejects(async () => withOperationContext(context, () =>
      startPeerChatReview(hostUrl, sessionUri, undefined, "/review")), OperationAbortedError);
  }
  assert.deepEqual(active.reads, []);
  assert.deepEqual(active.actions, []);
  lease.finish();
});

test("owned peer creation rechecks authority after the asynchronous capability read", async () => {
  active = harness();
  const { authority, context, lease } = ownedOperation();
  const acquired = deferred();
  const release = deferred();
  active.onRead = async (resource) => {
    if (resource === "ahp-root://") {
      acquired.resolve();
      await release.promise;
    }
  };
  const operation = withOperationContext(context, () =>
    startPeerChatReview("ws://fake", uri, undefined, "/review"));
  await acquired.promise;
  authority.mode = "observe";
  release.resolve();
  const result = await operation;
  assert.equal(result.success, false);
  assert.deepEqual(active.requests, []);
  assert.deepEqual(active.actions, []);
  lease.finish();
});

test("ended authoritative session access prevents peer creation after a capability read", async () => {
  active = harness();
  const acquired = deferred();
  const release = deferred();
  active.onRead = async (resource) => {
    if (resource === "ahp-root://") {
      acquired.resolve();
      await release.promise;
    }
  };
  const operation = startPeerChatReview("ws://fake", uri, undefined, "/review");
  await acquired.promise;
  await active.end(uri);
  await tick();
  release.resolve();
  assert.equal((await operation).success, false);
  assert.deepEqual(active.requests, []);
});

test("downgrade after peer creation disposes that identity without starting a review prompt", async () => {
  active = harness();
  const { authority, context, lease } = ownedOperation();
  const created = deferred();
  const release = deferred();
  active.onRequest = async (method) => {
    if (method === "createChat") {
      created.resolve();
      await release.promise;
    }
  };
  const operation = withOperationContext(context, () =>
    startPeerChatReview("ws://fake", uri, undefined, "/review"));
  await created.promise;
  authority.mode = "observe";
  release.resolve();
  assert.equal((await operation).success, false);
  assert.deepEqual(active.requests, ["createChat", "disposeChat"]);
  assert.deepEqual(active.actions, []);
  lease.finish();
});

test("a raced-out peer creation keeps admission until its actual acknowledgement and cleanup", async () => {
  active = harness();
  const { context, lease, admission, controller } = ownedOperation();
  const created = deferred();
  const release = deferred();
  active.onRequest = async (method) => {
    if (method === "createChat") {
      created.resolve();
      await release.promise;
    }
  };
  const operation = withOperationContext(context, () =>
    startPeerChatReview("ws://fake", uri, undefined, "/review"));
  const waiter = awaitAbortable(() => operation, controller.signal);
  await created.promise;
  controller.abort();
  await assert.rejects(waiter, OperationAbortedError);
  lease.finish();
  assert.equal(admission.acquire("ws://fake", uri), null);
  release.resolve();
  await assert.rejects(operation, OperationAbortedError);
  assert.deepEqual(active.requests, ["createChat", "disposeChat"]);
  assert.deepEqual(active.actions, []);
  const replacement = admission.acquire("ws://fake", uri);
  assert.ok(replacement, "the late create and exact cleanup are now confirmed");
  replacement.finish();
});

test("partial input dispatch followed by authority loss is ambiguous and quarantines admission", async () => {
  active = harness();
  active.session.inputNeeded = [pendingInput()];
  const { authority, context, lease, admission } = ownedOperation();
  active.onDispatch = () => { authority.mode = "observe"; };
  await assert.rejects(withOperationContext(context, () =>
    answerInput("ws://fake", uri, "request:1", "accept", { question: { value: true } })),
  MessageDispatchAmbiguousError);
  assert.deepEqual(active.actions.map(({ action }) => action.type), ["chat/inputAnswerChanged"]);
  lease.finish();
  assert.equal(admission.isQuarantined("ws://fake", uri), true);
  assert.equal(admission.acquire("ws://fake", uri), null);
});

test("automatic unconfirmed archive writes are never retried and quarantine their slot", async () => {
  active = harness();
  active.echo = false;
  const { context, lease, admission } = ownedOperation();
  const result = await withOperationContext(context, () =>
    setSessionArchived("ws://fake", uri, true, { verifyTimeoutMs: 2 }));
  assert.equal(result.success, false);
  assert.equal(active.actions.length, 1);
  lease.finish();
  assert.equal(admission.isQuarantined("ws://fake", uri), true);
});

test("input success requires authoritative consumption, not ping or optimistic dispatch", async () => {
  active = harness();
  active.session.inputNeeded = [pendingInput()];
  active.echo = false;
  const notApplied = await answerInputWithClient(
    active.client, uri, "request:1", "accept", undefined, { verifyTimeoutMs: 1 },
  );
  assert.deepEqual(notApplied, { success: false });
  assert.deepEqual(active.reads, [uri]);
  active.reads.length = 0;
  active.echo = true;
  const applied = await answerInputWithClient(
    active.client, uri, "request:1", "accept", { question: { value: true } }, { verifyTimeoutMs: 100 },
  );
  assert.deepEqual(applied, { success: true });
  assert.deepEqual(active.reads, [uri]);
  assert.equal(active.actions.at(-1)?.channel, "ahp-chat:/owning-input");
});

test("unknown input is not dispatched and observed absence is stale", async () => {
  active = harness();
  delete active.session.inputNeeded;
  assert.deepEqual(await answerInputWithClient(active.client, uri, "request:1", "accept"), { success: false });
  active.session.inputNeeded = [];
  assert.deepEqual(await answerInputWithClient(active.client, uri, "request:1", "accept"), { success: false, stale: true });
  assert.deepEqual(active.actions, []);
});

test("missing, creating or failed archive snapshots cannot verify unarchive or dispatch archive", async () => {
  for (const missing of [true, false]) {
    for (const lifecycle of ["creating", "failed"]) {
      for (const archived of [true, false]) {
        active = harness();
        active.missing = missing;
        active.session.lifecycle = lifecycle as SessionState["lifecycle"];
        const result = await setSessionArchived("ws://fake", uri, archived, {
          readyTimeoutMs: 1, verifyTimeoutMs: 1,
        });
        assert.equal(result.success, false);
        assert.equal(result.verified, false);
        assert.deepEqual(active.actions, []);
        assert.deepEqual(active.reads, [uri]);
      }
    }
  }
});

test("archive waits for authoritative readiness and confirms the echoed bit on its original subscription", async () => {
  active = harness();
  active.session.lifecycle = "creating" as SessionState["lifecycle"];
  const operation = setSessionArchived("ws://fake", uri, true, { readyTimeoutMs: 100, verifyTimeoutMs: 100 });
  await tick();
  assert.deepEqual(active.actions, []);
  active.push(uri, { type: "session/ready" } as StateAction);
  const result = await operation;
  assert.equal(result.success, true);
  assert.equal(result.status & AHPStatus.IsArchived, AHPStatus.IsArchived);
  assert.deepEqual(active.reads, [uri]);
});

test("archive ignores optimistic local writes and retries once without resubscribing", async () => {
  active = harness();
  active.echo = false;
  const result = await setSessionArchived("ws://fake", uri, true, { verifyTimeoutMs: 10 });
  assert.equal(result.success, false);
  assert.equal(result.verified, false);
  assert.equal(active.actions.length, 2);
  assert.deepEqual(active.reads, [uri]);
});

test("archive needs a valid status even when lifecycle is ready, and ready noops remain verified", async () => {
  for (const status of [undefined, NaN, -1]) {
    active = harness();
    active.session.status = status as number;
    assert.equal((await setSessionArchived("ws://fake", uri, false, { readyTimeoutMs: 1 })).verified, false);
    assert.deepEqual(active.actions, []);
  }
  active = harness();
  const noop = await setSessionArchived("ws://fake", uri, false);
  assert.equal(noop.verified, true);
  assert.deepEqual(active.actions, []);
});

test("input route retains the session and consumes both elicitation and tool confirmation echoes", async () => {
  active = harness();
  active.session.inputNeeded = [pendingInput()];
  const response = await inputRoute(request({ requestId: "request:1", response: "accept" }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, inputRemoved: true });
  assert.deepEqual(active.reads, [uri]);

  active = harness();
  active.session.inputNeeded = [{
    id: "tool:1", kind: "toolConfirmation", chat: "ahp-chat:/tool", turnId: "turn:1",
    toolCall: { toolCallId: "call:1", status: "pending-confirmation", displayName: "Read", toolName: "read" },
  }] as unknown as SessionState["inputNeeded"];
  const toolResponse = await inputRoute(request({ requestId: "tool:1", approved: false }));
  assert.equal(toolResponse.status, 200);
  assert.deepEqual(await toolResponse.json(), { ok: true, inputRemoved: true });
  assert.deepEqual(active.reads, [uri]);
});

test("file review retains parent and changeset and verifies authoritative actions without rereads", async () => {
  active = harness();
  const response = await reviewRoute(request({ files: ["a"], reviewed: true }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.deepEqual(body.review.files, [{ id: "a", reviewed: true }]);
  assert.deepEqual(active.reads, [uri, changesetUri]);
  assert.equal(active.releases.at(-1), uri);
});

test("file review cannot report an unconfirmed optimistic update as applied", async () => {
  active = harness();
  active.echo = false;
  active.onDispatch = () => { void active.end(changesetUri); };
  const response = await reviewRoute(request({ files: ["a"], reviewed: true }));
  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /not applied/);
  assert.deepEqual(active.reads, [uri, changesetUri]);
});

test("request cancellation during dispatched input or review is ambiguous and closes the owned client", async () => {
  for (const route of [inputRoute, reviewRoute]) {
    active = harness();
    active.session.inputNeeded = [pendingInput()];
    const controller = new AbortController();
    active.ping = () => new Promise<void>(() => {});
    active.onDispatch = () => controller.abort();
    const response = await route(request({
      requestId: "request:1", response: "accept", files: ["a"], reviewed: true,
    }, controller.signal));
    assert.equal(response.status, 502);
    assert.match((await response.json()).error, /may have been dispatched/);
    assert.equal(active.shutdowns, 1);
    assert.equal(active.actions.length, 1);
  }
});

test("cancelled requests cannot dispatch input or file review before acquiring state", async () => {
  for (const route of [inputRoute, reviewRoute]) {
    active = harness();
    const controller = new AbortController();
    controller.abort();
    const response = await route(request({
      requestId: "request:1", response: "accept", files: ["a"], reviewed: true,
    }, controller.signal));
    assert.equal(response.status, 502);
    assert.match((await response.json()).error, /cancelled/);
    assert.deepEqual(active.reads, []);
    assert.deepEqual(active.actions, []);
  }
});

test("a confirmed send remains successful when cancellation interrupts subscription cleanup", async () => {
  active = harness();
  let release!: () => void;
  active.cleanupWait = new Promise<void>((resolve) => { release = resolve; });
  const controller = new AbortController();
  active.ping = async () => { setImmediate(() => controller.abort()); };
  try {
    const result = await injectMessage("ws://fake", uri, "Continue", { signal: controller.signal });
    assert.equal(result.success, true);
    assert.equal(active.shutdowns, 1);
  } finally {
    release();
    await tick();
  }
});

test("cancellation after a partial input answer is ambiguous and never dispatches completion", async () => {
  active = harness();
  active.session.inputNeeded = [pendingInput()];
  const controller = new AbortController();
  active.onDispatch = () => controller.abort();
  await assert.rejects(answerInputWithClient(
    active.client, uri, "request:1", "accept", { question: true }, { signal: controller.signal },
  ), MessageDispatchAmbiguousError);
  assert.deepEqual(active.actions.map(({ action }) => action.type), ["chat/inputAnswerChanged"]);
});

test("cancellation during input consumption verification is ambiguous, not a safe retry", async () => {
  for (const closeFirst of [true, false]) {
    active = harness();
    active.session.inputNeeded = [pendingInput()];
    active.echo = false;
    const controller = new AbortController();
    const operation = answerInput(
      "ws://fake", uri, "request:1", "accept", undefined, { signal: controller.signal },
    );
    await tick();
    if (closeFirst) void active.end(uri);
    controller.abort();
    await assert.rejects(operation, MessageDispatchAmbiguousError);
    assert.deepEqual(active.reads, [uri]);
    assert.equal(active.shutdowns, 1);
  }
});

test("subscription cleanup failures preserve the original operation error", async () => {
  active = harness();
  const failure = new Error("operation failure");
  active.cleanupError = new Error("cleanup failure");
  const warn = console.warn;
  console.warn = () => {};
  try {
    await assert.rejects(withSessionState(active.client, uri, async () => {
      throw failure;
    }), (error) => error === failure);
  } finally {
    console.warn = warn;
  }
  assert.deepEqual(active.releases, [uri]);
});
