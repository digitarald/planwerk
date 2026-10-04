import type { InitializeResult } from "@microsoft/agent-host-protocol";
import type { AhpClient } from "@microsoft/agent-host-protocol/client";

import { assertNegotiatedProtocolVersion, OFFERED_PROTOCOL_VERSIONS } from "./protocol.ts";
import { readProtocolCompatibilityError } from "./protocol-rpc.ts";

export interface InitializeAhpClientOptions {
  clientId?: string;
  initialSubscriptions?: readonly string[];
}

export interface InitializedAhpClient {
  client: AhpClient;
  initialized: InitializeResult;
}

export async function connectInitializedClient(
  createClient: () => Promise<AhpClient>,
  options: InitializeAhpClientOptions = {},
): Promise<InitializedAhpClient> {
  const client = await createClient();
  try {
    const initialized = await client.initialize({
      clientId: options.clientId ?? crypto.randomUUID(),
      protocolVersions: OFFERED_PROTOCOL_VERSIONS,
      initialSubscriptions: options.initialSubscriptions ?? [],
    });
    assertNegotiatedProtocolVersion(initialized.protocolVersion);
    return { client, initialized };
  } catch (error) {
    await client.shutdown().catch(() => {});
    throw readProtocolCompatibilityError(error) ?? error;
  }
}
