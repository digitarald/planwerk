import {
  chatReducer,
  changesetReducer,
  type BackgroundWork,
  type ChatAction,
  type ChatState,
  type ChangesetAction,
  type ChangesetState,
  type SessionChatSummary,
  type SessionState,
} from "@microsoft/agent-host-protocol";
import type { AhpClient, Subscription } from "@microsoft/agent-host-protocol/client";
import type { ChatChangesetFacts, ChatDetails, SessionCurrentTool } from "../types.ts";
import { asChangesetState } from "./changeset-readiness.ts";
import { projectChatUsage } from "./chat-usage.ts";
import { shouldReadLiveSessionState } from "./session-read-policy.ts";
import { isStaticChangesetUri } from "./changeset-review.ts";

// The SDK fans one channel out to multiple local iterators. Unsubscribe only
// after the last chat observer releases a shared changeset channel.
const channelOwners = new WeakMap<object, Map<string, number>>();

export function shouldObserveChat(chat: SessionChatSummary, sessionStatus: number, defaultChat: string | undefined, alreadyObserved: boolean): boolean {
  if (chat.interactivity === "hidden" || (sessionStatus & 64) !== 0 || (chat.status !== undefined && (chat.status & 64) !== 0)) return false;
  return alreadyObserved || (shouldReadLiveSessionState(sessionStatus) && (
    (chat.status !== undefined && shouldReadLiveSessionState(chat.status))
    || chat.resource === defaultChat
  ));
}

export function canSendToChat(chat: { interactivity?: string } | undefined): boolean {
  return chat?.interactivity === undefined || chat.interactivity === "full";
}

export function projectPendingMessages(chat: Pick<ChatState, "steeringMessage" | "queuedMessages">): NonNullable<ChatDetails["pendingMessages"]> {
  return [
    ...(chat.steeringMessage ? [{ ...chat.steeringMessage, kind: "steering" as const }] : []),
    ...(chat.queuedMessages ?? []).map((entry) => ({ ...entry, kind: "queued" as const })),
  ].map((entry) => ({ id: entry.id, kind: entry.kind, text: entry.message.text ?? "" }));
}

/** Check both the fresh session catalogue and subscribed chat before dispatch. */
export async function assertDefaultChatWritable(client: Pick<AhpClient, "subscribe" | "unsubscribe">, session: Pick<SessionState, "chats" | "defaultChat">): Promise<void> {
  if (!session.defaultChat) return;
  if (!canSendToChat(session.chats.find((chat) => chat.resource === session.defaultChat))) {
    throw new Error("This chat does not accept messages");
  }
  const { result, subscription } = await client.subscribe(session.defaultChat);
  try {
    const state = result.snapshot?.state as ChatState | undefined;
    if (!state || !Array.isArray(state.turns)) throw new Error("The agent host did not return chat details");
    if (!canSendToChat(state)) throw new Error("This chat does not accept messages");
  } finally {
    await subscription.close().catch(() => {});
    await client.unsubscribe(session.defaultChat).catch(() => {});
  }
}

export function visibleChatCatalog(chats: readonly SessionChatSummary[] | undefined): SessionChatSummary[] | undefined {
  return chats?.filter((chat) => chat.interactivity !== "hidden");
}

export function projectChatChangeset(resource: string, label: string, changeKind: string, state: ChangesetState | undefined): ChatChangesetFacts {
  return {
    resource, label, changeKind, status: state?.status ?? "unknown",
    // Retained files during recomputation are not current evidence.
    files: state?.status === "ready" ? state.files.map((file) => ({
      id: file.id,
      path: file.edit.after?.uri ?? file.edit.before?.uri ?? file.id,
      added: file.edit.diff?.added ?? 0,
      removed: file.edit.diff?.removed ?? 0,
      reviewed: file.reviewed === true,
    })) : undefined,
  };
}

const SHELL_TOOLS = /^(bash|powershell|shell|run_in_terminal|terminal)$/i;

/** The most recent tool the active turn is preparing or running, if any. */
export function currentToolFromChat(state: Pick<ChatState, "activeTurn">): SessionCurrentTool | undefined {
  const parts = state.activeTurn?.responseParts ?? [];
  for (let index = parts.length - 1; index >= 0; index--) {
    const part = parts[index];
    if (part.kind !== ("toolCall" as typeof part.kind) || !("toolCall" in part)) continue;
    const call = part.toolCall;
    const status = call.status as string;
    if (status !== "running" && status !== "streaming") continue;
    let command: string | undefined;
    if (SHELL_TOOLS.test(call.toolName) && "toolInput" in call && typeof call.toolInput === "string") {
      try {
        const input = JSON.parse(call.toolInput) as { command?: unknown };
        if (typeof input.command === "string") command = input.command.trim().slice(0, 160) || undefined;
      } catch { /* non-JSON input carries no command */ }
    }
    return { id: call.toolCallId, name: call.toolName, displayName: call.displayName || undefined, command };
  }
  return undefined;
}

export function visibleBackgroundWork(state: Pick<ChatState, "backgroundWork" | "interactivity">, chats: readonly SessionChatSummary[] = []): BackgroundWork[] {
  if (state.interactivity === "hidden") return [];
  return (state.backgroundWork ?? []).filter((work) => work.kind !== "subagent"
    || chats.find((chat) => chat.resource === work.chat)?.interactivity !== "hidden");
}

/** Observe a resident chat and its static changesets. One owner controls all
 * subscriptions, so removing a catalogue entry also fences late snapshots. */
export function observeChatFacts(
  client: Pick<AhpClient, "subscribe" | "unsubscribe">,
  resource: string,
  onState: (state: ChatState, details: ChatDetails) => void,
  onError: (error: unknown) => void,
  onEnded: () => void = () => {},
): { close(): void; ready: Promise<void> } {
  let closed = false;
  let chat: ChatState | undefined;
  let subscription: Subscription | undefined;
  const entries = new Map<string, { close(): void; facts: ChatChangesetFacts }>();
  const publish = () => {
    if (!closed && chat) onState(chat, {
      changesets: [...entries.values()].map((entry) => entry.facts),
      usage: projectChatUsage(chat),
      pendingMessages: projectPendingMessages(chat),
    });
  };
  const owners = channelOwners.get(client) ?? new Map<string, number>();
  channelOwners.set(client, owners);
  const subscribe = async (uri: string) => {
    owners.set(uri, (owners.get(uri) ?? 0) + 1);
    try { return await client.subscribe(uri); }
    catch (error) { releaseOwner(uri); throw error; }
  };
  const releaseOwner = (uri: string) => {
    const remaining = (owners.get(uri) ?? 1) - 1;
    if (remaining > 0) owners.set(uri, remaining);
    else { owners.delete(uri); void client.unsubscribe(uri).catch(onError); }
  };
  const release = (uri: string, sub: Subscription) => {
    void sub.close();
    releaseOwner(uri);
  };
  const close = () => {
    if (closed) return;
    closed = true;
    if (subscription) release(resource, subscription);
    for (const entry of entries.values()) entry.close();
    entries.clear();
  };
  function syncChangesets() {
    const catalog = (chat?.changesets ?? []).filter((entry) => isStaticChangesetUri(entry.uriTemplate));
    for (const [uri, entry] of entries) {
      if (!catalog.some((item) => item.uriTemplate === uri)) { entries.delete(uri); entry.close(); }
    }
    for (const item of catalog) {
      const uri = item.uriTemplate;
      const existing = entries.get(uri);
      if (existing) {
        existing.facts = { ...existing.facts, label: item.label, changeKind: item.changeKind };
        continue;
      }
      let sub: Subscription | undefined;
      let state: ChangesetState | undefined;
      const entry = {
        facts: projectChatChangeset(uri, item.label, item.changeKind, undefined),
        close: () => { if (sub) release(uri, sub); },
      };
      entries.set(uri, entry);
      const current = () => !closed && entries.get(uri) === entry;
      void (async () => {
        try {
          const initial = await subscribe(uri);
          sub = initial.subscription;
          if (!current()) { release(uri, sub); return; }
          state = asChangesetState(initial.result.snapshot);
          entry.facts = projectChatChangeset(uri, entry.facts.label, entry.facts.changeKind, state);
          publish();
          for await (const event of sub) {
            if (!current()) break;
            if (event.type !== "action" || !state) continue;
            state = changesetReducer(state, event.params.action as ChangesetAction);
            entry.facts = projectChatChangeset(uri, entry.facts.label, entry.facts.changeKind, state);
            publish();
          }
        } catch (error) {
          if (current()) {
            entry.facts = projectChatChangeset(uri, item.label, item.changeKind, undefined);
            publish(); onError(error);
          }
        } finally {
          if (current() && sub) {
            entry.close(); sub = undefined;
            entry.facts = projectChatChangeset(uri, entry.facts.label, entry.facts.changeKind, undefined);
            publish();
          }
        }
      })();
    }
    publish();
  }
  const ready = (async () => {
    try {
      const initial = await subscribe(resource);
      subscription = initial.subscription;
      if (closed) { release(resource, subscription); return; }
      chat = initial.result.snapshot?.state as ChatState | undefined;
      if (!chat || !Array.isArray(chat.turns)) throw new Error("Missing chat state");
      if (chat.interactivity === "hidden" || (chat.status & 64) !== 0) {
        onState(chat, { changesets: [] });
        close(); onEnded();
        return;
      }
      syncChangesets();
      void (async () => {
        try {
          for await (const event of subscription!) {
            if (closed) break;
            if (event.type !== "action") continue;
            const previousStatus = chat!.status;
            chat = chatReducer(chat!, event.params.action as ChatAction);
            if ((chat.status & 64) !== 0) { onState(chat, { changesets: [] }); break; }
            if (previousStatus !== chat.status || /^chat\/(backgroundWorkSet|backgroundWorkRemoved|changesetsChanged|activityChanged|isArchivedChanged|isReadChanged|usage|turnStarted|turnComplete|turnCancelled|turnResume|error|turnsLoaded|toolCallStart|toolCallReady|toolCallConfirmed|toolCallComplete|toolCallAuthRequired|toolCallAuthResolved)$/.test(event.params.action.type)) syncChangesets();
          }
        } catch (error) { if (!closed) onError(error); }
        finally { if (!closed) { close(); onEnded(); } }
      })();
    } catch (error) { if (!closed) { onError(error); close(); onEnded(); } }
  })();
  return { ready, close };
}
