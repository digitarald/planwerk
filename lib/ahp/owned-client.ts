import { throwIfAborted } from "../abort.ts";

export interface OwnedClient {
  shutdown(): Promise<void>;
}

export async function withOwnedClient<TClient extends OwnedClient, TResult>(
  createClient: () => Promise<TClient>,
  operation: (client: TClient) => Promise<TResult>,
  onCleanupError: (error: unknown) => void,
  signal?: AbortSignal,
): Promise<TResult> {
  throwIfAborted(signal);
  const client = await createClient();

  try {
    throwIfAborted(signal);
    return await operation(client);
  } finally {
    try {
      await client.shutdown();
    } catch (error) {
      onCleanupError(error);
    }
  }
}
