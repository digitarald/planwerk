import type { AhpClient } from "@microsoft/agent-host-protocol/client";

import { chatTurnStarted } from "./actions.ts";
import type { CreatePeerChatParams } from "./peer-chat-core.ts";
import {
  dispatchAndConfirm,
  MessageDispatchAmbiguousError,
} from "./dispatch-confirmation.ts";

export interface PeerReviewDispatchResult {
  success: boolean;
  chatUri: string;
  turnId: string;
  reason?: string;
  failureKind?: "pre-dispatch" | "ambiguous-disposed";
}

export class PeerChatCleanupRequiredError extends Error {
  readonly chatUri: string;
  readonly turnId?: string;
  readonly cleanupError: unknown;
  readonly dispatchAmbiguous: boolean;
  readonly cleanupAttempts = 1;

  constructor(
    message: string,
    options: ErrorOptions & {
      chatUri: string;
      turnId?: string;
      cleanupError: unknown;
      dispatchAmbiguous: boolean;
    },
  ) {
    super(message, options);
    this.name = "PeerChatCleanupRequiredError";
    this.chatUri = options.chatUri;
    this.turnId = options.turnId;
    this.cleanupError = options.cleanupError;
    this.dispatchAmbiguous = options.dispatchAmbiguous;
  }
}

export async function disposePeerChatAfterFailure(
  client: Pick<AhpClient, "request">,
  chatUri: string,
  failure: unknown,
  options?: {
    turnId?: string;
    dispatchAmbiguous?: boolean;
    context?: string;
  },
): Promise<void> {
  try {
    await client.request("disposeChat", { channel: chatUri });
  } catch (cleanupError) {
    const context = options?.context ?? "Peer review dispatch failed";
    throw new PeerChatCleanupRequiredError(
      `${context}; peer chat cleanup is required.`,
      {
        cause: failure,
        chatUri,
        turnId: options?.turnId,
        cleanupError,
        dispatchAmbiguous: options?.dispatchAmbiguous ?? false,
      },
    );
  }
}

export async function createPeerChatWithCleanupOnFailure(
  client: Pick<AhpClient, "request">,
  params: CreatePeerChatParams,
): Promise<void> {
  try {
    await client.request("createChat", params);
  } catch (createError) {
    // A rejected acknowledgement does not prove that the host did not apply
    // createChat. The caller already chose the immutable URI, so dispose that
    // exact identity before allowing the review start to retry.
    await disposePeerChatAfterFailure(client, params.chat, createError, {
      context: "Peer review chat creation acknowledgement failed",
    });
    throw createError;
  }
}

export async function dispatchPeerChatReviewWithClient(
  client: Pick<AhpClient, "dispatch" | "ping" | "request">,
  chatUri: string,
  turnId: string,
  message: string,
  signal?: AbortSignal,
  confirmStarted?: () => Promise<boolean>,
): Promise<PeerReviewDispatchResult> {
  try {
    await dispatchAndConfirm(
      client,
      chatUri,
      chatTurnStarted(turnId, message),
      "The peer review prompt may have been dispatched before confirmation failed.",
      signal,
    );
    if (confirmStarted) {
      try {
        if (!await confirmStarted()) throw new Error("The exact peer review turn was not observed.");
      } catch (error) {
        throw new MessageDispatchAmbiguousError("The host did not confirm the exact peer review turn.", { cause: error });
      }
    }
    return { success: true, chatUri, turnId };
  } catch (dispatchError) {
    const ambiguous = dispatchError instanceof MessageDispatchAmbiguousError;
    await disposePeerChatAfterFailure(client, chatUri, dispatchError, {
      turnId,
      dispatchAmbiguous: ambiguous,
      context: ambiguous
        ? dispatchError.message
        : "Peer review dispatch failed before delivery",
    });

    if (ambiguous) {
      throw new MessageDispatchAmbiguousError(dispatchError.message, {
        cause: dispatchError, chatUri, turnId,
      });
    }

    return {
      success: false,
      chatUri,
      turnId,
      failureKind: "pre-dispatch",
      reason: dispatchError instanceof Error
        ? dispatchError.message
        : String(dispatchError),
    };
  }
}
