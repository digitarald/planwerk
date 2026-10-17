export type SdkCleanupOperation =
  | "abort"
  | "delete"
  | "disconnect"
  | "stop"
  | "force-stop"
  | "invalidate-runtime"
  | "release-runtime";

export class CopilotCleanupTimeoutError extends Error {
  readonly code: string = "COPILOT_SDK_CLEANUP_TIMEOUT";
  readonly operation: SdkCleanupOperation;

  constructor(
    operation: SdkCleanupOperation,
    timeoutMs: number,
  ) {
    super(`Copilot SDK ${operation} exceeded the ${timeoutMs}ms cleanup timeout`);
    this.name = "CopilotCleanupTimeoutError";
    this.operation = operation;
  }
}

export interface SdkCleanupOptions {
  timeoutMs?: number;
  timeoutError?: (
    operation: SdkCleanupOperation,
    timeoutMs: number,
  ) => Error;
}

export async function withSdkCleanupTimeout<T>(
  operation: () => Promise<T>,
  name: SdkCleanupOperation,
  options: SdkCleanupOptions = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1) {
    throw new RangeError("Copilot SDK cleanup timeout must be at least 1ms");
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(
            options.timeoutError?.(name, timeoutMs) ??
              new CopilotCleanupTimeoutError(name, timeoutMs),
          );
        }, timeoutMs);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
