import assert from "node:assert/strict";
import test from "node:test";
import { chatReducer, type ChatAction, type ChatState, type SessionState, type StateAction } from "@microsoft/agent-host-protocol";
import type { StateAccess } from "./snapshot.ts";
import {
  assertConversationChat, ConversationConflictError, loadConversationHistory,
  mutateConversation, prepareConversationMutation, projectConversation,
} from "./conversation-core.ts";
import { MessageDispatchAmbiguousError } from "./dispatch-confirmation.ts";
import { mergeConversationEvidence } from "./conversation-evidence.ts";
import { projectPendingMessages } from "./chat-facts.ts";

const chatUri = "ahp-chat:/lead";
const message = (text: string) => ({ text, origin: { kind: "user" } });
const turn = (id: string) => ({ id, message: message(id), state: "complete", responseParts: [{ kind: "markdown", content: `${id} result` }] });
const state = (extra: object = {}) => ({ resource: chatUri, title: "Lead", modifiedAt: "2026-10-31T00:00:00Z", turns: [], status: 1, ...extra }) as ChatState;
const session = (extra: object = {}) => ({ status: 1, provider: "agent", chats: [{ resource: chatUri }], ...extra }) as SessionState;

function access(initial: ChatState) {
  let current = initial;
  const listeners = new Set<(action: StateAction) => void>();
  let ended = false;
  const handle: StateAccess<ChatState> = {
    getState: () => current,
    assertCurrent: () => { if (ended) throw new Error("Disconnected"); },
    onAction(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    async waitFor(predicate) { handle.assertCurrent(); return predicate(current); },
  };
  return {
    handle,
    echo(action: StateAction) {
      current = chatReducer(current, action as ChatAction);
      for (const listener of listeners) listener(action);
    },
    end() { ended = true; },
    listeners,
  };
}

test("send stays idle/busy-specific and steering is explicit, replacing only the steering slot", () => {
  assert.equal(prepareConversationMutation(state(), { operation: "send", message: "hello" }).action.type, "chat/turnStarted");
  const busy = state({ activeTurn: { id: "active" }, steeringMessage: { id: "old", message: message("old") } });
  const queued = prepareConversationMutation(busy, { operation: "send", message: "hello" }).action;
  assert.equal(queued.type, "chat/pendingMessageSet");
  assert.equal((queued as { kind: string }).kind, "queued");
  const steering = prepareConversationMutation(busy, { operation: "steer", message: "redirect" }).action;
  const next = chatReducer(busy, steering as ChatAction);
  assert.equal(next.steeringMessage!.message.text, "redirect");
  assert.notEqual(next.steeringMessage!.id, "old");
  assert.throws(() => prepareConversationMutation(state(), { operation: "steer", message: "redirect" }), ConversationConflictError);
});

test("edits and cancellation require stable ID, original text and an unconsumed pending message", () => {
  const pending = state({ queuedMessages: [{ id: "q", message: { ...message("old"), attachments: [{ uri: "ref" }] } }] });
  const edit = { operation: "edit", kind: "queued", id: "q", expectedText: "old", message: "new" } as const;
  const action = prepareConversationMutation(pending, edit).action;
  assert.equal((action as { id: string }).id, "q");
  assert.deepEqual((action as { message: { attachments: unknown } }).message.attachments, [{ uri: "ref" }]);
  assert.throws(() => prepareConversationMutation(state(), edit), /consumed or removed/);
  assert.throws(() => prepareConversationMutation(pending, { ...edit, expectedText: "stale" }), /changed/);
  assert.throws(() => prepareConversationMutation(state(), { operation: "cancel", kind: "queued", id: "q", expectedText: "old" }), /consumed/);
});

test("stale reorders retain unseen new IDs rather than deleting pending messages", () => {
  const pending = state({ queuedMessages: ["a", "new", "b"].map((id) => ({ id, message: message(id) })) });
  const { action } = prepareConversationMutation(pending, { operation: "reorder", order: ["b", "gone", "a"] });
  assert.deepEqual(chatReducer(pending, action as ChatAction).queuedMessages!.map((entry) => entry.id), ["b", "a", "new"]);
});

test("wrong ownership, hidden and read-only catalogs/states and archives fail closed", () => {
  assert.throws(() => assertConversationChat(session(), "other"), /belong/);
  assert.throws(() => assertConversationChat(session(), chatUri, false, state({ resource: "other" })), /belong/);
  for (const interactivity of ["hidden", "read-only"]) {
    assert.throws(() => assertConversationChat(session({ chats: [{ resource: chatUri, interactivity }] }), chatUri, true));
    assert.throws(() => assertConversationChat(session(), chatUri, true, state({ interactivity })));
  }
  assert.doesNotThrow(() => assertConversationChat(session({ status: 65 }), chatUri, false));
  assert.throws(() => assertConversationChat(session({ status: 65 }), chatUri, true));
});

test("a ping acknowledgment alone cannot confirm a mutation and cannot trigger a retry", async () => {
  const observer = access(state());
  let dispatched = 0;
  await assert.rejects(mutateConversation({
    dispatch() { dispatched++; return { clientSeq: dispatched }; }, async ping() { return {} as never; },
  }, chatUri, { operation: "send", message: "new" }, observer.handle, () => observer.handle.assertCurrent()), MessageDispatchAmbiguousError);
  assert.equal(dispatched, 1);
  assert.equal(observer.listeners.size, 0);
});

test("host echo confirms queued/cancelled, while consumption is not reported as completed work", async () => {
  const observer = access(state({ activeTurn: { id: "active", message: message("current"), responseParts: [] } }));
  const client = {
    dispatch(_channel: string, action: StateAction) { observer.echo(action); return { clientSeq: 1 }; },
    async ping() { return {} as never; },
  };
  const result = await mutateConversation(client, chatUri, { operation: "send", message: "new" }, observer.handle, () => {});
  assert.equal(result.outcome, "queued");
  const cancel = await mutateConversation(client, chatUri, { operation: "cancel", kind: "queued", id: result.id!, expectedText: "new" }, observer.handle, () => {});
  assert.equal(cancel.outcome, "cancelled");
  client.dispatch = (_channel, action) => {
    observer.echo(action);
    observer.echo({ type: "chat/pendingMessageRemoved", kind: "steering", id: (action as { id: string }).id } as StateAction);
    return { clientSeq: 1 };
  };
  const steering = await mutateConversation(client, chatUri, { operation: "steer", message: "now" }, observer.handle, () => {});
  assert.equal(steering.outcome, "consumed-or-removed");
});

test("consumption during setup and cancellation prevent any new upsert; disconnected confirmation remains unknown", async () => {
  const observer = access(state({ queuedMessages: [{ id: "q", message: message("old") }] }));
  let dispatched = 0;
  const client = { dispatch() { dispatched++; return { clientSeq: dispatched }; }, async ping() { return {} as never; } };
  const mutate = () => mutateConversation(client, chatUri, { operation: "edit", kind: "queued", id: "q", expectedText: "old", message: "new" }, observer.handle, () => {
    observer.echo({ type: "chat/pendingMessageRemoved", kind: "queued", id: "q" } as StateAction);
  });
  await assert.rejects(mutate(), /consumed/);
  assert.equal(dispatched, 0);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(mutateConversation(client, chatUri, { operation: "send", message: "x" }, observer.handle, () => {}, controller.signal));
  assert.equal(dispatched, 0);
  client.dispatch = () => { dispatched++; observer.end(); return { clientSeq: dispatched }; };
  await assert.rejects(mutateConversation(client, chatUri, { operation: "send", message: "x" }, observer.handle, () => observer.handle.assertCurrent()), /Disconnected/);
  assert.equal(dispatched, 1);
});

test("history loads only the exact opaque cursor, reduces host pages oldest-first, and ignores command bodies", async () => {
  const observer = access(state({ turns: [turn("new")], turnsNextCursor: "opaque" }));
  let requests = 0;
  const client = {
    async request(method: string, params: unknown) {
      requests++;
      assert.equal(method, "fetchTurns");
      assert.deepEqual(params, { channel: chatUri, cursor: "opaque" });
      observer.echo({ type: "chat/turnsLoaded", turns: [turn("old"), turn("new")], turnsNextCursor: "next" } as unknown as StateAction);
      return { fabricatedTurns: [turn("fake")] } as never;
    },
  };
  const ids = await loadConversationHistory(client, chatUri, "opaque", observer.handle, () => observer.handle.assertCurrent());
  assert.deepEqual(ids, ["old", "new"]);
  assert.deepEqual(observer.handle.getState()!.turns.map((turn) => turn.id), ["old", "new"]);
  assert.equal(observer.handle.getState()!.turnsNextCursor, "next");
  await assert.rejects(loadConversationHistory(client, chatUri, "opaque", observer.handle, () => {}), /stale/);
  await assert.rejects(loadConversationHistory(client, chatUri, "", observer.handle, () => {}), /exhausted/);
  assert.equal(requests, 1);
  assert.equal(observer.listeners.size, 0);
});

test("empty historical page clears exhausted cursor, duplicate pages keep stable provenance, absent echo is failure", async () => {
  const observer = access(state({ turns: [turn("new")], turnsNextCursor: "opaque" }));
  await loadConversationHistory({ async request() {
    observer.echo({ type: "chat/turnsLoaded", turns: [] } as unknown as StateAction);
    return {} as never;
  } }, chatUri, "opaque", observer.handle, () => {});
  assert.equal(observer.handle.getState()!.turnsNextCursor, undefined);
  const previous = projectConversation(session(), state({ turns: [turn("new")] }), undefined);
  const page = projectConversation(session(), state({ turns: [turn("old"), turn("new")] }), undefined);
  const merged = mergeConversationEvidence(mergeConversationEvidence(previous, page), page);
  assert.deepEqual(merged.turns.map((turn) => [turn.chatUri, turn.turnId]), [[chatUri, "old"], [chatUri, "new"]]);
  const noEcho = access(state({ turnsNextCursor: "next" }));
  await assert.rejects(loadConversationHistory({ async request() { return {} as never; } }, chatUri, "next", noEcho.handle, () => {}), /did not publish/);
  assert.equal(noEcho.listeners.size, 0);
});

test("history failures and reconnects do not retry or leak action listeners", async () => {
  const observer = access(state({ turnsNextCursor: "next" }));
  let requests = 0;
  await assert.rejects(loadConversationHistory({ async request() { requests++; throw new Error("InvalidParams"); } },
    chatUri, "next", observer.handle, () => {}), /InvalidParams/);
  assert.equal(requests, 1);
  assert.equal(observer.listeners.size, 0);
  observer.end();
  await assert.rejects(loadConversationHistory({ async request() { requests++; return {} as never; } },
    chatUri, "next", observer.handle, () => observer.handle.assertCurrent()), /Disconnected/);
  assert.equal(requests, 1);
});

test("bounded evidence excludes unrelated historical pages and discloses omitted excerpts", () => {
  const turns = Array.from({ length: 60 }, (_, index) => turn(String(index)));
  const page = projectConversation(session(), state({ turns }), undefined, ["0", "1"]);
  assert.deepEqual(page.turns.map((turn) => turn.turnId), ["0", "1"]);
  const tail = projectConversation(session(), state({ turns }), undefined);
  assert.equal(tail.turns.length, 40);
  assert.equal(tail.historyTruncated, true);
});

test("history bounds retain recent outcomes instead of displacing them with older pages", () => {
  const recent = projectConversation(session(), state({ turns: [turn("latest")] }), undefined);
  let evidence = recent;
  for (let page = 5; page >= 0; page--) {
    const turns = Array.from({ length: 40 }, (_, index) => turn(String(page * 40 + index)));
    evidence = mergeConversationEvidence(evidence, projectConversation(session(), state({ turns }), undefined));
  }
  assert.equal(evidence.turns.length, 200);
  assert.equal(evidence.turns.at(-1)!.turnId, "latest");
  assert.equal(evidence.turns.some((turn) => turn.turnId === "0"), false);
  assert.equal(evidence.historyTruncated, true);
});

test("live and explicit reads share pending identities, order and text; absent catalog membership is never writable", () => {
  const chat = state({
    steeringMessage: { id: "same", message: message("steer") },
    queuedMessages: [{ id: "same", message: message("queue") }],
  });
  const expected = [
    { id: "same", kind: "steering", text: "steer" },
    { id: "same", kind: "queued", text: "queue" },
  ];
  assert.deepEqual(projectPendingMessages(chat), expected);
  assert.deepEqual(projectConversation(session(), chat, undefined).pending, expected);
  assert.equal(projectConversation(session({ chats: [] }), chat, undefined).writable, false);
});
