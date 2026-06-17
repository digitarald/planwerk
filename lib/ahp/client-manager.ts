import "server-only";

import { AhpClient } from "@microsoft/agent-host-protocol/client";
import { SUPPORTED_PROTOCOL_VERSIONS } from "@microsoft/agent-host-protocol";
import { WebSocketTransport } from "@microsoft/agent-host-protocol/ws";

const OFFERED_PROTOCOL_VERSIONS = [...SUPPORTED_PROTOCOL_VERSIONS, "0.4.0"];

let activeClient: { hostUrl: string; client: AhpClient; refs: number } | null = null;
let pendingInit: Promise<AhpClient> | null = null;

export async function getAHPClient(hostUrl: string): Promise<AhpClient> {
  // Fast path: reuse existing connection to same host
  if (activeClient && activeClient.hostUrl === hostUrl) {
    activeClient.refs++;
    return activeClient.client;
  }

  // If another call is already initializing, wait for it
  if (pendingInit) {
    const client = await pendingInit;
    if (activeClient && activeClient.hostUrl === hostUrl) {
      activeClient.refs++;
      return client;
    }
    // Host changed while we were waiting — fall through to create new
  }

  // Close existing if switching hosts
  if (activeClient) {
    await activeClient.client.shutdown().catch(() => {});
    activeClient = null;
  }

  // Create with mutex via promise
  pendingInit = (async () => {
    const transport = await WebSocketTransport.connect(hostUrl);
    const client = new AhpClient(transport);
    client.connect();

    await client.initialize({
      clientId: crypto.randomUUID(),
      protocolVersions: OFFERED_PROTOCOL_VERSIONS,
      initialSubscriptions: [],
    });

    activeClient = { hostUrl, client, refs: 1 };
    pendingInit = null;
    return client;
  })();

  try {
    return await pendingInit;
  } catch (err) {
    pendingInit = null;
    throw err;
  }
}

export function releaseAHPClient(hostUrl: string): void {
  if (activeClient && activeClient.hostUrl === hostUrl) {
    activeClient.refs--;
    if (activeClient.refs <= 0) {
      activeClient.client.shutdown().catch(() => {});
      activeClient = null;
    }
  }
}
