import "server-only";

import type { AhpClient } from "@microsoft/agent-host-protocol/client";

import { throwIfAborted } from "../abort.ts";
import { connectInitializedAhpClient } from "./endpoint";
import { withOwnedClient } from "./owned-client";

/**
 * Run one imperative AHP operation on an exclusively owned connection.
 *
 * AHP subscriptions are URI-global within an AhpClient: unsubscribe(uri)
 * terminates every local consumer for that URI. Sharing clients across
 * concurrent operations therefore lets one operation cancel another. Persistent
 * observers own their own clients; transient operations use this helper.
 */
export function withAHPClient<TResult>(
  hostUrl: string,
  operation: (client: AhpClient) => Promise<TResult>,
  signal?: AbortSignal,
): Promise<TResult> {
  throwIfAborted(signal);
  return withOwnedClient(
    async () => (await connectInitializedAhpClient(hostUrl, { signal })).client,
    async (client) => {
      throwIfAborted(signal);
      return operation(client);
    },
    (error) => {
      console.error(
        "[ahp:client] Failed to shut down client after confirmed operation:",
        error instanceof Error ? error.message : error,
      );
    },
    signal,
  );
}
