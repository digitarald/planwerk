import "server-only";

import type { AhpClient, Subscription } from "@microsoft/agent-host-protocol/client";
import {
  chatReducer,
  changesetReducer,
  sessionReducer,
  type ChatAction,
  type ChangesetAction,
  type ChangesetState,
  type SessionAction,
  type ChatState,
  type RootState,
  type SessionState,
  type Snapshot,
  type StateAction,
} from "@microsoft/agent-host-protocol";
import { awaitAbortable, awaitWithTimeout, throwIfAborted } from "../abort.ts";
import { listAllSessions } from "./catalog";
import { shouldReadLiveSessionState } from "./session-read-policy";
import { asChangesetState } from "./changeset-readiness";

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

/** Narrow the root-channel snapshot to {@link RootState}. */
export function asRootState(snapshot: Snapshot | undefined): RootState | undefined {
  if (snapshot?.resource !== "ahp-root://") return undefined;
  const state = snapshot.state;
  if (!state || !Array.isArray((state as Partial<RootState>).agents)) return undefined;
  return state as RootState;
}

/** Narrow a chat-channel (`ahp-chat:`) snapshot to {@link ChatState}. */
export function asChatState(snapshot: Snapshot | undefined): ChatState | undefined {
  if (!snapshot?.resource.startsWith("ahp-chat:")) return undefined;
  return snapshot.state as ChatState;
}

/** One-shot read of the host root state and agent capabilities. */
export async function readRootState(client: AhpClient): Promise<RootState | undefined> {
  const { result, subscription } = await client.subscribe("ahp-root://");
  try {
    return asRootState(result.snapshot);
  } finally {
    await releaseSubscription(client, "ahp-root://", subscription);
  }
}

/**
 * One-shot read of a session channel: subscribe, capture the snapshot, then close the
 * local iterator and release the server-side subscription. Use when you need the current
 * {@link SessionState} without an ongoing stream. This can restore/resume a cold
 * provider and mutate its activity timestamp; it is NOT a passive read.
 */
export async function readSessionState(
  client: AhpClient,
  sessionUri: string,
): Promise<SessionState | undefined> {
  return withSessionState(client, sessionUri, async (state) => state);
}

/** Background reads must first establish activity from the passive catalog. */
export async function readActiveSessionState(
  client: AhpClient,
  sessionUri: string,
): Promise<SessionState | undefined> {
  const summary = (await listAllSessions(client)).find((item) => item.resource === sessionUri);
  if (!summary || !shouldReadLiveSessionState(summary.status)) {
    throw new Error("Live session read deferred: session is inactive, archived, or unavailable");
  }
  return readSessionState(client, sessionUri);
}

export interface StateAccess<TState> {
  getState(): TState | undefined;
  waitFor(
    predicate: (state: TState | undefined) => boolean,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<boolean>;
}

export type SessionStateAccess = StateAccess<SessionState>;

async function releaseSubscription(
  client: AhpClient,
  uri: string,
  subscription: Subscription,
  signal?: AbortSignal,
): Promise<void> {
  const cleanup = Promise.allSettled([
    awaitWithTimeout(() => subscription.close(), 1_000, "AHP subscription close timed out"),
    awaitWithTimeout(() => client.unsubscribe(uri), 1_000, "AHP unsubscribe timed out"),
  ]).then((results) => {
    for (const result of results) {
      if (result.status === "rejected") {
        console.warn("[ahp:snapshot] Subscription cleanup failed:", result.reason);
      }
    }
  });
  try {
    await awaitAbortable(() => cleanup, signal);
  } catch (error) {
    // The owned connection is closing on abort. Do not hold up a confirmed
    // result behind unsubscribe acknowledgements from that closed transport.
    if (!signal?.aborted) throw error;
  }
}

async function withChannelState<TState, TResult>(
  client: AhpClient,
  uri: string,
  narrow: (snapshot: Snapshot | undefined) => TState | undefined,
  reduce: (state: TState, action: StateAction) => TState,
  operation: (state: TState | undefined, access: StateAccess<TState>) => Promise<TResult>,
  signal?: AbortSignal,
): Promise<TResult> {
  throwIfAborted(signal);
  const { result, subscription } = await client.subscribe(uri);
  let state = narrow(result.snapshot);
  let ended = false;
  let streamError: unknown;
  const listeners = new Set<() => void>();
  const notify = () => { for (const listener of listeners) listener(); };
  const stopped = Symbol("stopped");
  let stopDrain!: () => void;
  const stop = new Promise<typeof stopped>((resolve) => {
    stopDrain = () => resolve(stopped);
  });
  // The SDK subscription contains host echoes, not optimistic local dispatches.
  const drain = (async () => {
    try {
      while (!ended) {
        // SDK reader.return() detaches without waking an already pending next().
        const next = await Promise.race([subscription.next(), stop]);
        if (next === stopped || ended || next.done) break;
        const event = next.value;
        if (event.type === "action" && state) {
          state = reduce(state, event.params.action);
          notify();
        }
      }
    } catch (error) {
      streamError = error;
    } finally {
      ended = true;
      notify();
    }
  })();
  const access: StateAccess<TState> = {
    getState: () => state,
    async waitFor(predicate, timeoutMs, waitSignal = signal) {
      if (predicate(state)) return true;
      throwIfAborted(waitSignal);
      let timer: ReturnType<typeof setTimeout> | undefined;
      let check: (() => void) | undefined;
      try {
        const matched = await awaitAbortable(() => new Promise<boolean>((resolve, reject) => {
          check = () => {
            try {
              if (predicate(state)) resolve(true);
              else {
                throwIfAborted(waitSignal);
                if (streamError) reject(streamError);
                else if (ended) resolve(false);
              }
            } catch (error) {
              reject(error);
            }
          };
          listeners.add(check);
          timer = setTimeout(() => resolve(false), Math.max(0, timeoutMs));
          check();
        }), waitSignal);
        // Confirmed state wins over cancellation; an ended stream or timeout
        // is not a confirmed mutation and must retain abort semantics.
        if (!matched) throwIfAborted(waitSignal);
        return matched;
      } finally {
        if (timer) clearTimeout(timer);
        if (check) listeners.delete(check);
      }
    },
  };
  try {
    throwIfAborted(signal);
    return await operation(state, access);
  } finally {
    ended = true;
    stopDrain();
    await drain;
    await releaseSubscription(client, uri, subscription, signal);
  }
}

/** Keep residency and the authoritative action stream until dependent work ends. */
export function withSessionState<T>(
  client: AhpClient,
  sessionUri: string,
  operation: (state: SessionState | undefined, access: SessionStateAccess) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  return withChannelState(
    client, sessionUri, asSessionState,
    (state, action) => {
      const next = sessionReducer(state, action as SessionAction);
      // The reducer omits an empty aggregate. After observing removal from a
      // known aggregate, retain that authoritative empty state, not "unknown".
      return action.type === "session/inputNeededRemoved"
        && Array.isArray(state.inputNeeded) && next.inputNeeded === undefined
        ? { ...next, inputNeeded: [] }
        : next;
    },
    operation, signal,
  );
}

export function withChatState<T>(
  client: AhpClient,
  chatUri: string,
  operation: (state: ChatState | undefined, access: StateAccess<ChatState>) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  return withChannelState(
    client, chatUri, asChatState,
    (state, action) => chatReducer(state, action as ChatAction),
    operation, signal,
  );
}

export function withChangesetState<T>(
  client: AhpClient,
  uri: string,
  operation: (state: ChangesetState | undefined, access: StateAccess<ChangesetState>) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  return withChannelState(
    client, uri, asChangesetState,
    (state, action) => changesetReducer(state, action as ChangesetAction),
    operation, signal,
  );
}

/**
 * One-shot read of a chat channel: subscribe, capture the snapshot, then close the local
 * iterator and release the server-side subscription. Use when you need the current
 * {@link ChatState} without an ongoing stream.
 */
export async function readChatState(
  client: AhpClient,
  chatUri: string,
  signal?: AbortSignal,
): Promise<ChatState | undefined> {
  return withChatState(client, chatUri, async (state) => state, signal);
}
