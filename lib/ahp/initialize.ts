import type { InitializeResult } from "@microsoft/agent-host-protocol";
import type { AhpClient } from "@microsoft/agent-host-protocol/client";

import { assertNegotiatedProtocolVersion, OFFERED_PROTOCOL_VERSIONS } from "./protocol.ts";

export interface InitializeAhpClientOptions {
  clientId?: string;
  initialSubscriptions?: readonly string[];
}

export async function initializeAhpClient(
  client: AhpClient,
  options: InitializeAhpClientOptions = {},
): Promise<InitializeResult> {
  const initialized = await client.initialize({
    clientId: options.clientId ?? crypto.randomUUID(),
    protocolVersions: OFFERED_PROTOCOL_VERSIONS,
    initialSubscriptions: options.initialSubscriptions ?? [],
  });
  assertNegotiatedProtocolVersion(initialized.protocolVersion);
  return initialized;
}
