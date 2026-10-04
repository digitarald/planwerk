import assert from "node:assert/strict";
import test from "node:test";
import { Subscription, type AhpClient, type SubscriptionEvent } from "@microsoft/agent-host-protocol/client";
import type { ChatState, ChangesetState, Snapshot, SessionChatSummary } from "@microsoft/agent-host-protocol";
import { canSendToChat, observeChatFacts, projectChatChangeset, visibleBackgroundWork, visibleChatCatalog, shouldObserveChat, assertDefaultChatWritable } from "./chat-facts.ts";

function stream() {
  const queued: SubscriptionEvent[] = [];
  let pending: ((result: IteratorResult<SubscriptionEvent>) => void) | undefined;
  let closed = false;
  return {
    push(action: unknown) {
      const event = { type: "action", params: { action } } as SubscriptionEvent;
      if (pending) { const resolve = pending; pending = undefined; resolve({ done: false, value: event }); }
      else queued.push(event);
    },
    iterator: {
      async next() {
        if (closed) return { done: true, value: undefined };
        if (queued.length) return { done: false, value: queued.shift()! };
        return new Promise<IteratorResult<SubscriptionEvent>>((resolve) => { pending = resolve; });
      },
      async return() { closed = true; pending?.({ done: true, value: undefined }); return { done: true, value: undefined }; },
      [Symbol.asyncIterator]() { return this; },
    } as AsyncIterableIterator<SubscriptionEvent>,
  };
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const chatUri = "ahp-chat:/lead";
const csUri = "ahp-changeset:/lead";
function chat(): ChatState {
  return { resource: chatUri, title: "Lead", status: 1, modifiedAt: "2026-10-04T00:00:00Z", turns: [], pendingMessages: [], changesets: [{ uriTemplate: csUri, label: "Lead edits", changeKind: "session" }] } as unknown as ChatState;
}
function files(status = "ready"): ChangesetState {
  return { status, files: [{ id: "a", edit: { after: { uri: "file:///repo/a.ts" }, diff: { added: 3, removed: 1 } } }] } as unknown as ChangesetState;
}

test("catalogue interactivity filters hidden chats and defaults absent interactivity to full", () => {
  const chats = [
    { resource: "full", title: "Full" },
    { resource: "read", title: "Read", interactivity: "read-only" },
    { resource: "hidden", title: "Hidden", interactivity: "hidden" },
  ] as SessionChatSummary[];
  assert.deepEqual(visibleChatCatalog(chats)?.map((chat) => chat.resource), ["full", "read"]);
  assert.equal(canSendToChat(chats[0]), true);
  assert.equal(canSendToChat(chats[1]), false);
  assert.equal(canSendToChat(chats[2]), false);
  assert.equal(canSendToChat({ interactivity: "future" }), false);
  assert.equal(visibleChatCatalog(undefined), undefined);
});

test("recomputing files stay unknown even when the host retains old files", () => {
  assert.equal(projectChatChangeset(csUri, "Edits", "session", files("recomputing")).files, undefined);
  assert.equal(projectChatChangeset(csUri, "Edits", "session", files()).files?.[0].added, 3);
});

test("hidden chats and hidden subagents never appear as background work", () => {
  const state = { backgroundWork: [{ kind: "shell", id: "shell", label: "Tests" }, { kind: "subagent", id: "agent", chat: "hidden", label: "Private" }] } as Pick<ChatState, "backgroundWork" | "interactivity">;
  const catalog = [{ resource: "hidden", interactivity: "hidden" }] as SessionChatSummary[];
  assert.deepEqual(visibleBackgroundWork(state, catalog).map((work) => work.id), ["shell"]);
  assert.deepEqual(visibleBackgroundWork({ ...state, interactivity: "hidden" as ChatState["interactivity"] }, catalog), []);
});

test("observes background work after an idle snapshot and streams scoped file refreshes", async () => {
  const chatStream = stream(); const csStream = stream();
  const reads: string[] = []; const releases: string[] = [];
  const client = {
    async subscribe(uri: string) {
      reads.push(uri);
      return { result: { snapshot: { resource: uri, state: uri === chatUri ? chat() : files() } as Snapshot }, subscription: new Subscription(uri, uri === chatUri ? chatStream.iterator : csStream.iterator) };
    },
    async unsubscribe(uri: string) { releases.push(uri); },
  } as Pick<AhpClient, "subscribe" | "unsubscribe">;
  const updates: { state: ChatState; files?: number; status?: string }[] = [];
  const observer = observeChatFacts(client, chatUri, (state, details) => updates.push({ state, files: details.changesets[0]?.files?.length, status: details.changesets[0]?.status }), (error) => { throw error; });
  await observer.ready; await tick();
  assert.deepEqual(reads, [chatUri, csUri]);
  assert.equal(updates.at(-1)?.files, 1);
  chatStream.push({ type: "chat/backgroundWorkSet", work: { kind: "shell", id: "test", label: "Tests", command: "npm test", startedAt: "2026-10-04T00:00:00Z" } });
  await tick();
  assert.equal(updates.at(-1)?.state.backgroundWork?.[0].id, "test");
  assert.equal(updates.at(-1)?.state.status, 1);
  csStream.push({ type: "changeset/statusChanged", status: "recomputing" });
  await tick();
  assert.equal(updates.at(-1)?.files, undefined);
  csStream.push({ type: "changeset/fileRemoved", fileId: "a" });
  csStream.push({ type: "changeset/statusChanged", status: "ready" });
  await tick();
  assert.equal(updates.at(-1)?.files, 0);
  chatStream.push({ type: "chat/backgroundWorkRemoved", id: "test" });
  chatStream.push({ type: "chat/changesetsChanged", changesets: [] });
  await tick();
  assert.deepEqual(updates.at(-1)?.state.backgroundWork, []);
  assert.deepEqual(releases, [csUri]);
  observer.close(); await tick();
  assert.deepEqual(releases, [csUri, chatUri]);
  const count = updates.length;
  chatStream.push({ type: "chat/backgroundWorkSet", work: { id: "late" } });
  await tick();
  assert.equal(updates.length, count);
});

test("closing while a chat snapshot is pending releases it without publishing", async () => {
  let resolve!: (value: Awaited<ReturnType<AhpClient["subscribe"]>>) => void;
  const pending = new Promise<Awaited<ReturnType<AhpClient["subscribe"]>>>((done) => { resolve = done; });
  const releases: string[] = [];
  const client = { subscribe: async () => pending, unsubscribe: async (uri: string) => { releases.push(uri); } } as Pick<AhpClient, "subscribe" | "unsubscribe">;
  const updates: unknown[] = [];
  const observer = observeChatFacts(client, chatUri, (state) => updates.push(state), (error) => assert.fail(String(error)));
  observer.close();
  resolve({ result: { snapshot: { resource: chatUri, fromSeq: 0, state: chat() } }, subscription: new Subscription(chatUri, stream().iterator) });
  await observer.ready;
  assert.deepEqual(updates, []);
  assert.deepEqual(releases, [chatUri]);
});

test("cold catalogues stay passive while existing observers survive idle and input-needed", () => {
  const item = { resource: chatUri, title: "Lead" } as SessionChatSummary;
  assert.equal(shouldObserveChat(item, 1, chatUri, false), false);
  assert.equal(shouldObserveChat(item, 1, chatUri, true), true);
  assert.equal(shouldObserveChat(item, 24, chatUri, true), true);
  assert.equal(shouldObserveChat(item, 24, chatUri, false), true);
  assert.equal(shouldObserveChat({ ...item, status: 8 }, 1, undefined, false), true);
  assert.equal(shouldObserveChat(item, 65, chatUri, true), false);
  assert.equal(shouldObserveChat({ ...item, status: 65 as SessionChatSummary["status"] }, 8, chatUri, true), false);
  assert.equal(shouldObserveChat({ ...item, interactivity: "hidden" as SessionChatSummary["interactivity"] }, 8, chatUri, true), false);
});

test("shared changeset channels are released only after their last observer closes", async () => {
  const streams: ReturnType<typeof stream>[] = [];
  const released: string[] = [];
  const client = {
    async subscribe(uri: string) {
      const queue = stream(); streams.push(queue);
      return { result: { snapshot: { resource: uri, fromSeq: 0, state: uri === csUri ? files() : { ...chat(), resource: uri } } as Snapshot }, subscription: new Subscription(uri, queue.iterator) };
    },
    async unsubscribe(uri: string) { released.push(uri); },
  } as Pick<AhpClient, "subscribe" | "unsubscribe">;
  const errors: unknown[] = [];
  const first = observeChatFacts(client, chatUri, () => {}, (error) => errors.push(error));
  const second = observeChatFacts(client, "ahp-chat:/reviewer", () => {}, (error) => errors.push(error));
  await Promise.all([first.ready, second.ready]); await tick();
  first.close(); await tick();
  assert.deepEqual(released, [chatUri]);
  second.close(); await tick();
  assert.deepEqual(released, [chatUri, "ahp-chat:/reviewer", csUri]);
  assert.deepEqual(errors, []);
});

test("ignores templated catalogues and fences a removed pending changeset", async () => {
  const chatStream = stream();
  let resolve!: (value: Awaited<ReturnType<AhpClient["subscribe"]>>) => void;
  const pending = new Promise<Awaited<ReturnType<AhpClient["subscribe"]>>>((done) => { resolve = done; });
  const reads: string[] = []; const released: string[] = [];
  const initialChat = chat();
  initialChat.changesets!.push({ uriTemplate: "ahp-changeset:/turn/{turnId}", label: "Turn", changeKind: "turn" });
  const client = {
    async subscribe(uri: string) {
      reads.push(uri);
      if (uri === csUri) return pending;
      return { result: { snapshot: { resource: uri, fromSeq: 0, state: initialChat } as Snapshot }, subscription: new Subscription(uri, chatStream.iterator) };
    },
    async unsubscribe(uri: string) { released.push(uri); },
  } as Pick<AhpClient, "subscribe" | "unsubscribe">;
  let lastFiles: number | undefined;
  const observer = observeChatFacts(client, chatUri, (_, details) => { lastFiles = details.changesets[0]?.files?.length; }, (error) => assert.fail(String(error)));
  await observer.ready;
  assert.deepEqual(reads, [chatUri, csUri]);
  chatStream.push({ type: "chat/changesetsChanged", changesets: [] });
  await tick();
  resolve({ result: { snapshot: { resource: csUri, fromSeq: 0, state: files() } }, subscription: new Subscription(csUri, stream().iterator) });
  await tick();
  assert.equal(lastFiles, undefined);
  assert.deepEqual(released, [csUri]);
  observer.close();
});

for (const interactivity of ["read-only", "hidden"] as const) {
  test(`rejects ${interactivity} message targets from either fresh catalogue or chat state`, async () => {
    let reads = 0; let releases = 0;
    const client = {
      async subscribe() { reads++; return { result: { snapshot: { resource: chatUri, fromSeq: 0, state: { ...chat(), interactivity } } as Snapshot }, subscription: new Subscription(chatUri, stream().iterator) }; },
      async unsubscribe() { releases++; },
    } as Pick<AhpClient, "subscribe" | "unsubscribe">;
    await assert.rejects(assertDefaultChatWritable(client, {
      defaultChat: chatUri,
      chats: [{ resource: chatUri, title: "Lead", interactivity }] as SessionChatSummary[] as never,
    }), /does not accept messages/);
    assert.equal(reads, 0);
    await assert.rejects(assertDefaultChatWritable(client, {
      defaultChat: chatUri, chats: [{ resource: chatUri, title: "Lead" }] as never,
    }), /does not accept messages/);
    assert.equal(reads, 1);
    assert.equal(releases, 1);
  });
}

test("ending a chat stream releases all channels and reports observer termination", async () => {
  const chatStream = stream();
  const released: string[] = [];
  const client = {
    async subscribe(uri: string) {
      return { result: { snapshot: { resource: uri, fromSeq: 0, state: uri === chatUri ? chat() : files() } as Snapshot }, subscription: new Subscription(uri, uri === chatUri ? chatStream.iterator : stream().iterator) };
    },
    async unsubscribe(uri: string) { released.push(uri); },
  } as Pick<AhpClient, "subscribe" | "unsubscribe">;
  let ended = 0;
  const observer = observeChatFacts(client, chatUri, () => {}, (error) => assert.fail(String(error)), () => { ended++; });
  await observer.ready; await tick();
  await chatStream.iterator.return!(); await tick();
  assert.equal(ended, 1);
  assert.deepEqual(released, [chatUri, csUri]);
  observer.close();
  assert.deepEqual(released, [chatUri, csUri]);
});

test("archiving a chat ends background observation and releases its changesets", async () => {
  const queue = stream(); const released: string[] = [];
  const client = {
    async subscribe(uri: string) {
      return { result: { snapshot: { resource: uri, fromSeq: 0, state: uri === chatUri ? chat() : files() } as Snapshot }, subscription: new Subscription(uri, uri === chatUri ? queue.iterator : stream().iterator) };
    },
    async unsubscribe(uri: string) { released.push(uri); },
  } as Pick<AhpClient, "subscribe" | "unsubscribe">;
  let ended = false;
  const observer = observeChatFacts(client, chatUri, () => {}, (error) => assert.fail(String(error)), () => { ended = true; });
  await observer.ready; await tick();
  queue.push({ type: "chat/isArchivedChanged", isArchived: true });
  await tick();
  assert.equal(ended, true);
  assert.deepEqual(released, [chatUri, csUri]);
});
