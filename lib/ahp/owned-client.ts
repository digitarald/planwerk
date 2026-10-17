import { awaitWithTimeout, OperationAbortedError, throwIfAborted } from "../abort.ts";

const CLEANUP_TIMEOUT_MS = 1_000;
const ABORT_OPERATION_GRACE_MS = 1_000;

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
  let cleanup: Promise<void> | undefined;
  const shutdown = () => cleanup ??= awaitWithTimeout(
    () => client.shutdown(),
    CLEANUP_TIMEOUT_MS,
    "Timed out shutting down the owned AHP client",
  ).catch((error) => {
    // Diagnostics must not replace an operation's error or confirmed result.
    try { onCleanupError(error); } catch {}
  });

  let abortTimer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => {
      void shutdown();
      // Close immediately. Operation-level confirmation helpers independently
      // preserve confirmed results and classify interrupted writes as ambiguous.
      // Only an operation that ignores both closure and cancellation uses this
      // bounded fallback; cleanup has its own separate deadline.
      abortTimer = setTimeout(
        () => reject(new OperationAbortedError(signal?.reason)),
        ABORT_OPERATION_GRACE_MS,
      );
    };
  });
  signal?.addEventListener("abort", onAbort!, { once: true });

  try {
    throwIfAborted(signal);
    return await Promise.race([operation(client), aborted]);
  } finally {
    signal?.removeEventListener("abort", onAbort!);
    if (abortTimer) clearTimeout(abortTimer);
    await shutdown();
  }
}
