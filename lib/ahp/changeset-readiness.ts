import {
  changesetReducer,
  type ChangesetAction,
  type ChangesetState,
  type Snapshot,
} from "@microsoft/agent-host-protocol";
import type {
  AhpClient,
  Subscription,
  SubscriptionEvent,
} from "@microsoft/agent-host-protocol/client";

export const CHANGESET_READY_TIMEOUT_MS = 5_000;

/** Narrow a snapshot to changeset state using fields unique to that channel. */
export function asChangesetState(snapshot: Snapshot | undefined): ChangesetState | undefined {
  const state = snapshot?.state;
  if (
    !state ||
    !Array.isArray((state as Partial<ChangesetState>).files) ||
    typeof (state as Partial<ChangesetState>).status !== "string"
  ) {
    return undefined;
  }
  return state as ChangesetState;
}

export async function waitForReadyChangesetState(
  initialState: ChangesetState,
  subscription: AsyncIterableIterator<SubscriptionEvent>,
  timeoutMs = CHANGESET_READY_TIMEOUT_MS,
): Promise<ChangesetState | undefined> {
  let state = initialState;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });

  try {
    while (true) {
      const next = await Promise.race([subscription.next(), timeout]);
      if (next === "timeout" || next.done) return undefined;
      if (next.value.type !== "action") continue;

      state = changesetReducer(state, next.value.params.action as ChangesetAction);
      if (state.status === "ready") return state;
      if (state.status === "error") return undefined;
    }
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function releaseChangesetSubscription(
  client: Pick<AhpClient, "unsubscribe">,
  uri: string,
  subscription: Subscription,
): Promise<void> {
  try {
    await subscription.close();
  } finally {
    await client.unsubscribe(uri);
  }
}

/**
 * Read a ready changeset snapshot, briefly following computation or recomputation
 * until the host publishes its terminal status. A timeout or host error remains
 * unknown rather than turning fallback counts into verified data.
 */
export async function readReadyChangesetState(
  client: Pick<AhpClient, "subscribe" | "unsubscribe">,
  uri: string,
  timeoutMs = CHANGESET_READY_TIMEOUT_MS,
): Promise<ChangesetState | undefined> {
  const initial = await client.subscribe(uri);
  const initialState = asChangesetState(initial.result.snapshot);

  try {
    if (initialState?.status === "ready") return initialState;
    if (initialState?.status !== "computing" && initialState?.status !== "recomputing") return undefined;

    return await waitForReadyChangesetState(
      initialState,
      initial.subscription,
      timeoutMs,
    );
  } finally {
    await releaseChangesetSubscription(client, uri, initial.subscription);
  }
}
