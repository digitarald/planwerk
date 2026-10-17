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
  const result = await awaitAbortable(operation, signal);
  throwIfAborted(signal);
  return result;
}

/** Stop waiting without leaving a late operation rejection unobserved. */
export async function awaitAbortable<TResult>(
  operation: () => Promise<TResult>,
  signal?: AbortSignal,
): Promise<TResult> {
  throwIfAborted(signal);
  if (!signal) return operation();

  let onAbort!: () => void;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(new OperationAbortedError(signal.reason));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([operation(), aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

export async function awaitWithTimeout<TResult>(
  operation: () => Promise<TResult>,
  timeoutMs: number,
  message: string,
): Promise<TResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
