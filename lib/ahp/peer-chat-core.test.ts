import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCreatePeerChatParams,
  supportsPeerChats,
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

test("creates an un-forked peer chat in the owning session", () => {
  assert.deepEqual(
    buildCreatePeerChatParams("copilotcli:/session", "review"),
    {
      channel: "copilotcli:/session",
      chat: "ahp-chat://review/Y29waWxvdGNsaTovc2Vzc2lvbg",
    },
  );
});
