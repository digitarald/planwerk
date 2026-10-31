import "server-only";

import type { ChatSource, ChatState, SessionState } from "@microsoft/agent-host-protocol";
import type { AhpClient } from "@microsoft/agent-host-protocol/client";
import { getSessionCacheSnapshot } from "../db/session-cache";
import { assertOperationCurrent, runOperationEffect } from "../orchestrator/operation-context";
import { withAHPClient } from "./client-operation";
import { listAllSessions } from "./catalog";
import { readRootState, withChatState, withSessionState, type StateAccess } from "./snapshot";
import {
  assertConversationChat, ConversationConflictError, loadConversationHistory,
  mutateConversation, projectConversation, type ConversationMutation,
} from "./conversation-core";
import { buildCreatePeerChatParams, supportsPeerChats, validateChatSource } from "./peer-chat-core";
import { createPeerChatWithCleanupOnFailure } from "./peer-review-dispatch";

/** This is an explicit user read/mutation, not a background hydration path. */
async function withConversation<T>(
  hostUrl: string, sessionUri: string, chatUri: string | undefined, writable: boolean,
  operation: (client: AhpClient, session: StateAccess<SessionState>, chat: StateAccess<ChatState>, assertCurrent: () => void) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const capability = writable ? "interact" : "observe";
  const assertOwner = () => {
    assertOperationCurrent(capability, { hostUrl, cardId: sessionUri });
    if (!getSessionCacheSnapshot(hostUrl, sessionUri)) throw new ConversationConflictError("Session ownership is unavailable or changed. Resolve ownership before continuing.");
  };
  assertOwner();
  return withAHPClient(hostUrl, async (client) => {
    // Passive catalog first: even explicit reads must not restore another host's session.
    const catalog = (await listAllSessions(client)).find((entry) => entry.resource === sessionUri);
    assertOwner();
    if (!catalog) throw new ConversationConflictError("This host no longer lists the session.");
    return withSessionState(client, sessionUri, async (state, session) => {
      if (!state) throw new ConversationConflictError("Session details are unavailable.");
      const target = chatUri ?? state.defaultChat;
      if (!target) throw new ConversationConflictError("The session does not expose a conversation.");
      assertConversationChat(state, target, writable);
      return withChatState(client, target, async (state, chat) => {
        if (!state) throw new ConversationConflictError("Conversation details are unavailable.");
        const assertCurrent = () => {
          assertOwner(); session.assertCurrent(); chat.assertCurrent();
          if (!chatUri && session.getState()?.defaultChat !== target) {
            throw new ConversationConflictError("The default conversation changed. Reload before sending.");
          }
          assertConversationChat(session.getState(), target, writable, chat.getState());
        };
        assertCurrent();
        return operation(client, session, chat, assertCurrent);
      }, signal);
    }, signal);
  }, signal);
}

export function readConversation(
  hostUrl: string, sessionUri: string, chatUri?: string, cursor?: string, signal?: AbortSignal,
) {
  return withConversation(hostUrl, sessionUri, chatUri, false, async (client, session, chat, assertCurrent) => {
    const root = await readRootState(client);
    assertCurrent();
    const turnIds = cursor !== undefined
      ? await loadConversationHistory(client, chat.getState()!.resource, cursor, chat, assertCurrent)
      : undefined;
    return projectConversation(session.getState()!, chat.getState()!, root, turnIds);
  }, signal);
}

export function changeConversation(
  hostUrl: string, sessionUri: string, chatUri: string | undefined, mutation: ConversationMutation, signal?: AbortSignal,
) {
  return withConversation(hostUrl, sessionUri, chatUri, true, async (client, session, chat, assertCurrent) => {
    const root = await readRootState(client);
    assertCurrent();
    const result = await runOperationEffect("interact", () =>
      mutateConversation(client, chat.getState()!.resource, mutation, chat, assertCurrent, signal));
    return { ...result, conversation: projectConversation(session.getState()!, chat.getState()!, root) };
  }, signal);
}

export function createContextualConversation(
  hostUrl: string, sessionUri: string, chatUri: string, source: ChatSource | undefined, signal?: AbortSignal,
) {
  return withConversation(hostUrl, sessionUri, chatUri, true, async (client, session, chat, assertCurrent) => {
    const root = await readRootState(client);
    assertCurrent();
    if (!supportsPeerChats(root, session.getState()!.provider)) throw new ConversationConflictError("The provider does not advertise multiple conversations.");
    if (source) validateChatSource(root, session.getState()!.provider, chat.getState()!, source);
    const params = { ...buildCreatePeerChatParams(sessionUri, crypto.randomUUID()), ...(source ? { source } : {}) };
    await runOperationEffect("interact", () => createPeerChatWithCleanupOnFailure(client, params));
    // A successful create acknowledgment is not sufficient to expose an unowned chat.
    if (!await session.waitFor((state) => !!state?.chats.some((entry) => entry.resource === params.chat), 5_000)) {
      throw new ConversationConflictError(`Conversation creation was accepted but is not yet visible. Do not create another copy. Chat: ${params.chat}`);
    }
    assertCurrent();
    return { chatUri: params.chat };
  }, signal);
}
