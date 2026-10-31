import assert from "node:assert/strict";
import test from "node:test";
import type { ChatSource, ChatState } from "@microsoft/agent-host-protocol";

import {
  buildCreatePeerChatParams,
  supportsPeerChats,
  contextualChatCapabilities,
  validateChatSource,
} from "./peer-chat-core.ts";

test("requires the session provider to advertise multiple chats", () => {
  const root = {
    agents: [
      { provider: "claude", capabilities: { multipleChats: {} } },
      { provider: "copilot", capabilities: { multipleChats: { fork: true } } },
      { provider: "codex", capabilities: {} },
    ],
  };

  assert.equal(supportsPeerChats(root, "claude"), true);
  assert.equal(supportsPeerChats(root, "copilot"), true);
  assert.equal(supportsPeerChats(root, "codex"), false);
  assert.equal(supportsPeerChats(root, "missing"), false);
});

test("contextual capabilities are independent and absent flags are unsupported", () => {
  const root = { agents: [{ provider: "agent", capabilities: { multipleChats: { fork: true } } }] };
  assert.deepEqual(contextualChatCapabilities(root, "agent"), { fork: true, sideChat: false, ordinary: true });
  assert.deepEqual(contextualChatCapabilities(undefined, "agent"), { fork: false, sideChat: false, ordinary: false });
  const chat = { resource: "chat", turns: [{ id: "done", state: "complete" }] } as ChatState;
  assert.throws(() => validateChatSource(root, "agent", chat, { kind: "sideChat", chat: "chat", turnId: "done" } as ChatSource), /does not advertise/);
});

test("forks require completed sources while side conversations snapshot stable active-turn identity", () => {
  const root = { agents: [{ provider: "agent", capabilities: { multipleChats: { fork: true, sideChat: true } } }] };
  const chat = {
    resource: "chat", turns: [{ id: "done", state: "complete" }, { id: "error", state: "error" }],
    activeTurn: { id: "active" },
  } as ChatState;
  const source = (kind: string, turnId: string) => ({ kind, chat: "chat", turnId }) as ChatSource;
  assert.doesNotThrow(() => validateChatSource(root, "agent", chat, source("fork", "done")));
  assert.doesNotThrow(() => validateChatSource(root, "agent", chat, source("sideChat", "active")));
  assert.throws(() => validateChatSource(root, "agent", chat, source("fork", "active")), /completed/);
  assert.throws(() => validateChatSource(root, "agent", chat, source("fork", "error")), /completed/);
  assert.throws(() => validateChatSource(root, "agent", chat, source("sideChat", "removed")), /no longer available/);
  assert.throws(() => validateChatSource(root, "agent", chat, { ...source("fork", "done"), chat: "other" }), /changed/);
});

test("selected text is an immutable value with advisory provenance, not a live source range", () => {
  const root = { agents: [{ provider: "agent", capabilities: { multipleChats: { sideChat: true } } }] };
  const chat = { resource: "chat", turns: [], activeTurn: { id: "active", responseParts: [] } } as unknown as ChatState;
  const source = Object.freeze({
    kind: "sideChat", chat: "chat", turnId: "active",
    selection: Object.freeze({ text: "Exact snapshot", responsePartId: "part" }),
  }) as ChatSource;
  validateChatSource(root, "agent", chat, source);
  chat.activeTurn = undefined;
  chat.turns = [{ id: "active", state: "complete", responseParts: [{ kind: "markdown", content: "Later response" }] }] as unknown as ChatState["turns"];
  validateChatSource(root, "agent", chat, source);
  assert.equal((source as { selection: { text: string } }).selection.text, "Exact snapshot");
  assert.throws(() => validateChatSource(root, "agent", chat, { ...source, selection: { text: " " } } as ChatSource), /empty/);
});

test("creates an un-forked peer chat in the owning session", () => {
  assert.deepEqual(
    buildCreatePeerChatParams("copilotcli:/session", "review"),
    {
      channel: "copilotcli:/session",
      chat: "ahp-chat://review/Y29waWxvdGNsaTovc2Vzc2lvbg",
    },
  );
});
