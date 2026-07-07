import "server-only";

import type { AhpClient } from "@microsoft/agent-host-protocol/client";
import type { ChatState, SessionState, Snapshot } from "@microsoft/agent-host-protocol";

/**
 * Typed access to AHP channel snapshots.
 *
 * `Snapshot.state` is a seven-member union (`RootState | SessionState | ChatState
 * | TerminalState | ChangesetState | ResourceWatchState | AnnotationsState`) — the
 * transport can't know which channel a URI addresses at the type level. Rather than
 * scatter `snapshot?.state as SessionState` casts across the codebase, this module is
 * the single place that narrows the union, keyed by the snapshot's `resource` scheme.
 * Every caller gets a properly typed state (or `undefined` for a scheme mismatch).
 */

/**
 * Narrow a session-channel snapshot to {@link SessionState}.
 *
 * Session channels are addressed by the agent provider's scheme (copilotcli
 * returns `copilotcli:/<uuid>`), not the canonical `ahp-session:` scheme the SDK
 * documents — so the URI scheme is not a reliable discriminator. `chats` is
 * unique to {@link SessionState} across the seven-member snapshot-state union
 * (ChatState exposes `turns`, ChangesetState `files`, etc.), so narrow on shape.
 * `chats` is a required `ChatSummary[]`, so an array check is a tight guard.
 */
export function asSessionState(snapshot: Snapshot | undefined): SessionState | undefined {
  const state = snapshot?.state;
  if (!state || !Array.isArray((state as Partial<SessionState>).chats)) return undefined;
  return state as SessionState;
}

/** Narrow a chat-channel (`ahp-chat:`) snapshot to {@link ChatState}. */
export function asChatState(snapshot: Snapshot | undefined): ChatState | undefined {
  if (!snapshot?.resource.startsWith("ahp-chat:")) return undefined;
  return snapshot.state as ChatState;
}

/**
 * One-shot read of a session channel: subscribe, capture the snapshot, then close the
 * local iterator and release the server-side subscription. Use when you need the current
 * {@link SessionState} without an ongoing stream.
 */
export async function readSessionState(
  client: AhpClient,
  sessionUri: string,
): Promise<SessionState | undefined> {
  const { result, subscription } = await client.subscribe(sessionUri);
  void subscription.close();
  await client.unsubscribe(sessionUri).catch(() => {});
  return asSessionState(result.snapshot);
}

/**
 * One-shot read of a chat channel: subscribe, capture the snapshot, then close the local
 * iterator and release the server-side subscription. Use when you need the current
 * {@link ChatState} without an ongoing stream.
 */
export async function readChatState(
  client: AhpClient,
  chatUri: string,
): Promise<ChatState | undefined> {
  const { result, subscription } = await client.subscribe(chatUri);
  void subscription.close();
  await client.unsubscribe(chatUri).catch(() => {});
  return asChatState(result.snapshot);
}
