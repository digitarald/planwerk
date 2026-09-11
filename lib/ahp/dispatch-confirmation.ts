import type { StateAction } from "@microsoft/agent-host-protocol";
import type { AhpClient } from "@microsoft/agent-host-protocol/client";

import { throwIfAborted } from "../abort.ts";

export class MessageDispatchAmbiguousError extends Error {
  readonly chatUri?: string;
  readonly turnId?: string;
  readonly cleanupError?: unknown;

  constructor(
    message: string,
    options?: ErrorOptions & {
      chatUri?: string;
      turnId?: string;
      cleanupError?: unknown;
    },
  ) {
    super(message, options);
    this.name = "MessageDispatchAmbiguousError";
    this.chatUri = options?.chatUri;
    this.turnId = options?.turnId;
    this.cleanupError = options?.cleanupError;
  }
}

export async function dispatchAndConfirm(
  client: Pick<AhpClient, "dispatch" | "ping">,
  channel: string,
  action: StateAction,
  ambiguousMessage: string,
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);

  // dispatch() is synchronous. A throw here proves that the action was not
  // accepted by the SDK and is therefore safe to retry.
  client.dispatch(channel, action);

  try {
    await client.ping();
  } catch (error) {
    throw new MessageDispatchAmbiguousError(ambiguousMessage, {
      cause: error,
    });
  }
}
