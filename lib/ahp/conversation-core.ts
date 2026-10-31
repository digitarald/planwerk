import type { ChatState, SessionState, StateAction } from "@microsoft/agent-host-protocol";
import type { AhpClient } from "@microsoft/agent-host-protocol/client";
import type { ConversationDetails } from "../types.ts";
import type { StateAccess } from "./snapshot.ts";
import { canSendToChat, projectPendingMessages } from "./chat-facts.ts";
import {
  chatPendingMessageRemoved, chatQueuedMessage, chatQueuedMessagesReordered,
  chatSteeringMessage, chatTurnStarted,
} from "./actions.ts";
import { dispatchAndConfirm, MessageDispatchAmbiguousError } from "./dispatch-confirmation.ts";
import { projectChatUsage } from "./chat-usage.ts";
import { contextualChatCapabilities } from "./peer-chat-core.ts";
import { extractLastAgentMessage } from "./response-parts.ts";

export type ConversationMutation =
  | { operation: "send" | "steer"; message: string }
  | { operation: "edit" | "cancel"; kind: "queued" | "steering"; id: string; expectedText: string; message?: string }
  | { operation: "reorder"; order: string[] };

export class ConversationConflictError extends Error {}

/** The catalog establishes membership before any chat subscription, including explicit cold reads. */
export function assertConversationChat(
  session: Pick<SessionState, "chats" | "status"> | undefined,
  chatUri: string,
  writable = false,
  chat?: ChatState,
): void {
  const entry = session?.chats.find((candidate) => candidate.resource === chatUri);
  if (!entry || entry.interactivity === "hidden" || chat?.interactivity === "hidden"
    || (chat && (chat.resource !== chatUri || !Array.isArray(chat.turns)))) {
    throw new ConversationConflictError("The conversation is unavailable or does not belong to this session.");
  }
  if (writable && (
    (session!.status & 64) !== 0 || ((entry.status ?? 0) & 64) !== 0
    || ((chat?.status ?? 0) & 64) !== 0 || !canSendToChat(entry) || (chat && !canSendToChat(chat))
  )) throw new ConversationConflictError("This conversation is archived or read-only.");
}

function pending(chat: ChatState, kind: "queued" | "steering", id: string) {
  return kind === "steering" ? (chat.steeringMessage?.id === id ? chat.steeringMessage : undefined)
    : chat.queuedMessages?.find((message) => message.id === id);
}

export function prepareConversationMutation(chat: ChatState, mutation: ConversationMutation): { id?: string; action: StateAction } {
  if (mutation.operation === "reorder") return { action: chatQueuedMessagesReordered(mutation.order) };
  if (mutation.operation === "edit" || mutation.operation === "cancel") {
    const current = pending(chat, mutation.kind, mutation.id);
    if (!current) throw new ConversationConflictError("The message was consumed or removed and can no longer be changed.");
    if (current.message.text !== mutation.expectedText) throw new ConversationConflictError("The pending message changed. Reload before editing.");
    if (mutation.operation === "cancel") return { id: mutation.id, action: chatPendingMessageRemoved(mutation.kind, mutation.id) };
    if (!mutation.message?.trim()) throw new ConversationConflictError("The message must not be empty.");
    return {
      id: mutation.id,
      action: {
        ...(mutation.kind === "steering" ? chatSteeringMessage(mutation.id, mutation.message.trim()) : chatQueuedMessage(mutation.id, mutation.message.trim())),
        message: { ...current.message, text: mutation.message.trim() },
      },
    };
  }
  if (!mutation.message?.trim()) throw new ConversationConflictError("The message must not be empty.");
  if (mutation.operation === "steer" && !chat.activeTurn) throw new ConversationConflictError("The conversation is no longer running. Send a new turn instead.");
  const id = crypto.randomUUID();
  return {
    id,
    action: mutation.operation === "steer" ? chatSteeringMessage(id, mutation.message.trim())
      : chat.activeTurn ? chatQueuedMessage(id, mutation.message.trim()) : chatTurnStarted(id, mutation.message.trim()),
  };
}

export function projectConversation(session: SessionState, chat: ChatState, root: unknown, turnIds?: readonly string[]): ConversationDetails {
  const observedAt = new Date().toISOString();
  const entry = session.chats.find((candidate) => candidate.resource === chat.resource);
  const turns = new Map(chat.turns.map((turn) => [turn.id, turn]));
  if (chat.activeTurn) turns.set(chat.activeTurn.id, { ...chat.activeTurn, state: "running" as ChatState["turns"][number]["state"] });
  const eligible = [...turns.values()].filter((turn) => !turnIds || turnIds.includes(turn.id));
  return {
    chatUri: chat.resource,
    writable: !!entry && canSendToChat(chat) && canSendToChat(entry)
      && (session.status & 64) === 0 && (chat.status & 64) === 0
      && ((entry.status ?? 0) & 64) === 0,
    running: !!chat.activeTurn,
    turns: eligible.slice(-40).map((turn) => {
      const text = extractLastAgentMessage([turn], 8_001);
      return {
        chatUri: chat.resource, turnId: turn.id, state: turn.state,
        startedAt: turn.startedAt, prompt: turn.message.text?.slice(0, 2_000),
        text: text?.slice(0, 8_000), truncated: (text?.length ?? 0) > 8_000 || (turn.message.text?.length ?? 0) > 2_000,
      };
    }),
    turnsNextCursor: chat.turnsNextCursor,
    pending: projectPendingMessages(chat),
    capabilities: contextualChatCapabilities(root, session.provider),
    usage: projectChatUsage(chat, observedAt),
    origin: chat.origin,
    observedAt,
    historyTruncated: eligible.length > 40,
  };
}

/** HTTP requests opt in explicitly; no heartbeat caller performs historical hydration. */
export async function loadConversationHistory(
  client: Pick<AhpClient, "request">, chatUri: string, cursor: string, chat: StateAccess<ChatState>,
  assertCurrent: () => void,
): Promise<string[]> {
  assertCurrent();
  if (!cursor || chat.getState()?.turnsNextCursor !== cursor) {
    throw new ConversationConflictError("History cursor is exhausted or stale. Reload the conversation.");
  }
  let loaded = false;
  let turnIds: string[] = [];
  const release = chat.onAction((action) => {
    if (action.type === "chat/turnsLoaded") {
      loaded = true;
      turnIds = action.turns.map((turn) => turn.id);
    }
  });
  try {
    await client.request("fetchTurns", { channel: chatUri, cursor });
    if (!await chat.waitFor(() => loaded, 5_000)) throw new Error("The host did not publish the historical page.");
    assertCurrent();
    return turnIds;
  } finally { release(); }
}

export async function mutateConversation(
  client: Pick<AhpClient, "dispatch" | "ping">, chatUri: string, mutation: ConversationMutation,
  chat: StateAccess<ChatState>, assertCurrent: () => void, signal?: AbortSignal,
) {
  assertCurrent();
  const state = chat.getState();
  if (!state) throw new ConversationConflictError("The host did not expose the conversation.");
  // No await between the consumption guard and dispatch. AHP v1 has no host CAS.
  const prepared = prepareConversationMutation(state, mutation);
  let echoed = false;
  const release = chat.onAction((action) => {
    const expected = prepared.action;
    if (action.type !== expected.type) return;
    if (action.type === "chat/pendingMessageSet" && expected.type === action.type) {
      echoed ||= action.id === expected.id && action.kind === expected.kind && action.message.text === expected.message.text;
    } else if (action.type === "chat/pendingMessageRemoved" && expected.type === action.type) {
      echoed ||= action.id === expected.id && action.kind === expected.kind;
    } else if (action.type === "chat/turnStarted" && expected.type === action.type) {
      echoed ||= action.turnId === expected.turnId && action.message.text === expected.message.text;
    } else if (action.type === "chat/queuedMessagesReordered" && expected.type === action.type) {
      echoed ||= JSON.stringify(action.order) === JSON.stringify(expected.order);
    }
  });
  try {
    await dispatchAndConfirm(client, chatUri, prepared.action,
      "Delivery is unknown. Reload pending messages before deciding whether to send again.", signal);
    if (!await chat.waitFor(() => echoed, 5_000)) throw new MessageDispatchAmbiguousError(
      "The host did not confirm this change. Reload the conversation; do not resend blindly.",
      { chatUri, turnId: prepared.id },
    );
    assertCurrent();
    const latest = chat.getState()!;
    const kind = prepared.action.type === "chat/pendingMessageSet" ? prepared.action.kind as "queued" | "steering" : undefined;
    const outcome = mutation.operation === "cancel" ? "cancelled"
      : mutation.operation === "reorder" ? "reordered"
      : kind && prepared.id ? (pending(latest, kind, prepared.id) ? (kind === "queued" ? "queued" : "steering-pending") : "consumed-or-removed")
      : "accepted";
    return { id: prepared.id, outcome };
  } finally { release(); }
}
