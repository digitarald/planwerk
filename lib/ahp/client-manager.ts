import "server-only";

import { AhpClient } from "@microsoft/agent-host-protocol/client";
import { SUPPORTED_PROTOCOL_VERSIONS } from "@microsoft/agent-host-protocol";
import { WebSocketTransport } from "@microsoft/agent-host-protocol/ws";

const OFFERED_PROTOCOL_VERSIONS = [...SUPPORTED_PROTOCOL_VERSIONS, "0.4.0"];

let activeClient: { hostUrl: string; client: AhpClient; refs: number } | null = null;

export async function getAHPClient(hostUrl: string): Promise<AhpClient> {
  if (activeClient && activeClient.hostUrl === hostUrl) {
    activeClient.refs++;
    return activeClient.client;
  }

  if (activeClient) {
    await activeClient.client.shutdown().catch(() => {});
    activeClient = null;
  }

  const transport = await WebSocketTransport.connect(hostUrl);
  const client = new AhpClient(transport);
  client.connect();

  await client.initialize({
    clientId: crypto.randomUUID(),
    protocolVersions: OFFERED_PROTOCOL_VERSIONS,
    initialSubscriptions: [],
  });

  activeClient = { hostUrl, client, refs: 1 };
  return client;
}

export function releaseAHPClient(): void {
  if (activeClient) {
    activeClient.refs--;
    if (activeClient.refs <= 0) {
      activeClient.client.shutdown().catch(() => {});
      activeClient = null;
    }
  }
}
