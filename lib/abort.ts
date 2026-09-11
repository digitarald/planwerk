export class OperationAbortedError extends Error {
  constructor(reason?: unknown) {
    super("Operation was cancelled.", { cause: reason });
    this.name = "AbortError";
  }
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new OperationAbortedError(signal.reason);
  }
}

export function isOperationAborted(error: unknown): boolean {
  return error instanceof OperationAbortedError;
}

export async function awaitAbortableBoundary<TResult>(
  operation: () => Promise<TResult>,
  signal?: AbortSignal,
): Promise<TResult> {
  throwIfAborted(signal);
  const result = await operation();
  throwIfAborted(signal);
  return result;
}
