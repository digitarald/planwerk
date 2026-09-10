import type { InitializeResult } from "@microsoft/agent-host-protocol";
import type { AhpClient } from "@microsoft/agent-host-protocol/client";

import {
  assertNegotiatedProtocolVersion,
  forwardRetryProtocolVersions,
  OFFERED_PROTOCOL_VERSIONS,
} from "./protocol.ts";
import { readProtocolCompatibilityError } from "./protocol-rpc.ts";

export interface InitializeAhpClientOptions {
  clientId?: string;
  initialSubscriptions?: readonly string[];
  allowForwardCompatibility?: boolean;
}

interface InitializeAttemptOptions extends InitializeAhpClientOptions {
  protocolVersions: readonly string[];
}

async function initializeAhpClient(
  client: AhpClient,
  options: InitializeAttemptOptions,
): Promise<InitializeResult> {
  const initialized = await client.initialize({
    clientId: options.clientId ?? crypto.randomUUID(),
    protocolVersions: options.protocolVersions,
    initialSubscriptions: options.initialSubscriptions ?? [],
  });
  assertNegotiatedProtocolVersion(initialized.protocolVersion, options.protocolVersions);
  return initialized;
}

export interface InitializedAhpClient {
  client: AhpClient;
  initialized: InitializeResult;
  usedForwardCompatibility: boolean;
}

export function shouldAllowForwardCompatibility(
  requested: boolean,
  nodeEnv: string | undefined = process.env.NODE_ENV,
): boolean {
  return nodeEnv !== "production" && requested;
}

export async function initializeAhpClientWithForwardRetry(
  createClient: () => Promise<AhpClient>,
  options: InitializeAhpClientOptions = {},
): Promise<InitializedAhpClient> {
  const connectionOptions = {
    ...options,
    clientId: options.clientId ?? crypto.randomUUID(),
    protocolVersions: OFFERED_PROTOCOL_VERSIONS,
  };
  let client = await createClient();
  try {
    const initialized = await initializeAhpClient(client, connectionOptions);
    return { client, initialized, usedForwardCompatibility: false };
  } catch (error) {
    const compatibilityError = readProtocolCompatibilityError(error);
    const retryVersions = compatibilityError
      ? forwardRetryProtocolVersions(
          compatibilityError,
          shouldAllowForwardCompatibility(
            connectionOptions.allowForwardCompatibility ?? true,
          ),
        )
      : undefined;
    if (!retryVersions) {
      await client.shutdown().catch(() => {});
      throw error;
    }

    await client.shutdown().catch(() => {});
    client = await createClient();
    try {
      const initialized = await initializeAhpClient(client, {
        ...connectionOptions,
        protocolVersions: retryVersions,
      });
      return { client, initialized, usedForwardCompatibility: true };
    } catch (retryError) {
      await client.shutdown().catch(() => {});
      throw readProtocolCompatibilityError(retryError, retryVersions) ?? retryError;
    }
  }
}
