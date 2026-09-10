import "server-only";

import type { AhpClient } from "@microsoft/agent-host-protocol/client";

import { connectInitializedAhpClient } from "./endpoint";

interface ClientEntry {
  client: AhpClient;
  refs: number;
}

// Keyed by hostUrl so concurrent callers on *different* hosts never contend
// for the same slot — switching hosts used to unconditionally shut down
// whatever client was active, even mid-use by another caller with refs > 0.
const clients = new Map<string, ClientEntry>();
const pendingInits = new Map<string, Promise<AhpClient>>();

export async function getAHPClient(hostUrl: string): Promise<AhpClient> {
  // Fast path: reuse existing connection to this host
  const existing = clients.get(hostUrl);
  if (existing) {
    existing.refs++;
    return existing.client;
  }

  // If another call is already initializing this same host, wait for it
  const pending = pendingInits.get(hostUrl);
  if (pending) {
    const client = await pending;
    const entry = clients.get(hostUrl);
    if (entry) entry.refs++;
    return client;
  }

  // Create with mutex via promise, scoped per host
  const init = (async () => {
    const { client } = await connectInitializedAhpClient(hostUrl);
    clients.set(hostUrl, { client, refs: 1 });
    pendingInits.delete(hostUrl);
    return client;
  })();
  pendingInits.set(hostUrl, init);

  try {
    return await init;
  } catch (err) {
    pendingInits.delete(hostUrl);
    throw err;
  }
}

export function releaseAHPClient(hostUrl: string): void {
  const entry = clients.get(hostUrl);
  if (!entry) return;
  entry.refs--;
  if (entry.refs <= 0) {
    clients.delete(hostUrl);
    entry.client.shutdown().catch(() => {});
  }
}
