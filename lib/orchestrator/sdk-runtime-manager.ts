import {
  ConnectionError,
  ConnectionErrors,
  ErrorCodes,
  ResponseError,
} from "vscode-jsonrpc/node.js";

import { withSdkCleanupTimeout } from "./sdk-lifecycle.ts";

export interface ManagedCopilotRuntimeClient {
  start(): Promise<void>;
  stop(): Promise<Error[]>;
  forceStop(): Promise<void>;
  ping(message?: string): Promise<{
    message: string;
    timestamp: string;
    protocolVersion?: number;
  }>;
  getStatus(): Promise<{
    version: string;
    protocolVersion: number;
  }>;
}

export type CopilotRuntimeState =
  | "stopped"
  | "starting"
  | "ready"
  | "resetting"
  | "stopping"
  | "failed";

export interface CopilotRuntimeHealth {
  state: CopilotRuntimeState;
  healthy: boolean;
  restartCount: number;
  startedAt?: string;
  lastCheckedAt?: string;
  blockedUntil?: string;
  lastError?: string;
  runtime?: {
    version: string;
    protocolVersion: number;
    pingTimestamp: string;
  };
}

export interface CopilotRuntimeManagerOptions<TClient extends ManagedCopilotRuntimeClient> {
  createClient: () => TClient;
  maxResets?: number;
  resetWindowMs?: number;
  now?: () => number;
  cleanupTimeoutMs?: number;
  startupTimeoutMs?: number;
  healthTimeoutMs?: number;
}

export class CopilotRuntimeDeadlineError extends Error {
  readonly code = "COPILOT_SDK_RUNTIME_DEADLINE";

  constructor(operation: "startup" | "health", timeoutMs: number) {
    super(`Copilot SDK ${operation} exceeded the ${timeoutMs}ms deadline`);
    this.name = "CopilotRuntimeDeadlineError";
  }
}

async function withRuntimeDeadline<T>(
  operation: () => Promise<T>,
  name: "startup" | "health",
  timeoutMs: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new CopilotRuntimeDeadlineError(name, timeoutMs)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export type CopilotFailureKind =
  | "transport"
  | "runtime-invalidating"
  | "domain";

export function classifyCopilotFailure(error: unknown): CopilotFailureKind {
  const candidate = error as { code?: unknown; name?: unknown };
  const code = typeof candidate?.code === "string" ? candidate.code : "";
  const name = typeof candidate?.name === "string" ? candidate.name : "";
  const message = errorMessage(error);
  if (
    code === "CTO_SESSION_CLEANUP_TIMEOUT" ||
    name === "CtoSessionCleanupTimeoutError" ||
    code === "COPILOT_SDK_CLEANUP_TIMEOUT" ||
    code === "COPILOT_SDK_RUNTIME_DEADLINE" ||
    name === "CopilotCleanupTimeoutError"
  ) {
    return "runtime-invalidating";
  }
  // SDK 1.0.22 propagates vscode-jsonrpc errors. Only these codes establish
  // transport failure; response data (including data.code) is application-owned.
  if (error instanceof ResponseError) {
    switch (error.code) {
      case ErrorCodes.MessageWriteError:
      case ErrorCodes.MessageReadError:
      case ErrorCodes.PendingResponseRejected:
      case ErrorCodes.ConnectionInactive:
        return "transport";
      default:
        return "domain";
    }
  }
  if (error instanceof ConnectionError) {
    return error.code === ConnectionErrors.Closed ||
      error.code === ConnectionErrors.Disposed
      ? "transport"
      : "domain";
  }
  if (/^(ECONNRESET|ECONNREFUSED|EPIPE|ENOTCONN|ETIMEDOUT)$/i.test(code) ||
      /\b(transport|connection|websocket|socket|broken pipe|rpc connection closed|client (?:is )?(?:stopped|closed|not started)|runtime (?:exited|unavailable))\b/i.test(
        `${name} ${message}`
      )) {
    return "transport";
  }
  return "domain";
}

export function isCopilotRuntimeInvalidatingFailure(error: unknown): boolean {
  return classifyCopilotFailure(error) !== "domain";
}

export interface CopilotRuntimeLease<TClient> {
  readonly client: TClient;
  readonly generation: number;
  invalidate(reason: unknown): Promise<boolean>;
  release(): Promise<void>;
}

export class CopilotRuntimeResetLimitError extends Error {
  readonly retryAt: number;

  constructor(retryAt: number) {
    super(`Copilot SDK restart limit reached; retry after ${new Date(retryAt).toISOString()}`);
    this.name = "CopilotRuntimeResetLimitError";
    this.retryAt = retryAt;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export class CopilotRuntimeManager<TClient extends ManagedCopilotRuntimeClient> {
  private readonly createClient: () => TClient;
  private readonly maxResets: number;
  private readonly resetWindowMs: number;
  private readonly now: () => number;
  private readonly cleanupTimeoutMs: number;
  private readonly startupTimeoutMs: number;
  private readonly healthTimeoutMs: number;
  private client: TClient | null = null;
  private generation = 0;
  private readonly clientGeneration = new Map<TClient, number>();
  private readonly activeOperations = new Map<TClient, number>();
  private readonly unhealthyClients = new Set<TClient>();
  private readonly cleanupStarted = new WeakSet<TClient>();
  private readonly timedOutStartups = new WeakSet<TClient>();
  private transition: Promise<void> = Promise.resolve();
  private state: CopilotRuntimeState = "stopped";
  private resetTimes: number[] = [];
  private restartCount = 0;
  private startedAt?: number;
  private lastCheckedAt?: number;
  private blockedUntil?: number;
  private lastError?: string;
  private runtimeStatus?: CopilotRuntimeHealth["runtime"];

  constructor(options: CopilotRuntimeManagerOptions<TClient>) {
    this.createClient = options.createClient;
    this.maxResets = options.maxResets ?? 3;
    this.resetWindowMs = options.resetWindowMs ?? 60_000;
    this.now = options.now ?? Date.now;
    this.cleanupTimeoutMs = options.cleanupTimeoutMs ?? 30_000;
    this.startupTimeoutMs = options.startupTimeoutMs ?? 30_000;
    this.healthTimeoutMs = options.healthTimeoutMs ?? 10_000;

    if (this.maxResets < 1) {
      throw new Error("maxResets must be at least 1");
    }
    if (this.resetWindowMs < 1) {
      throw new Error("resetWindowMs must be at least 1");
    }
    if (!Number.isFinite(this.cleanupTimeoutMs) || this.cleanupTimeoutMs < 1) {
      throw new RangeError("Copilot SDK cleanup timeout must be at least 1ms");
    }
    for (const [name, timeout] of [
      ["startup", this.startupTimeoutMs],
      ["health", this.healthTimeoutMs],
    ] as const) {
      if (!Number.isFinite(timeout) || timeout < 1) {
        throw new RangeError(`Copilot SDK ${name} timeout must be at least 1ms`);
      }
    }
  }

  getHealth(): CopilotRuntimeHealth {
    return {
      state: this.state,
      healthy: this.state === "ready",
      restartCount: this.restartCount,
      startedAt:
        this.startedAt !== undefined
          ? new Date(this.startedAt).toISOString()
          : undefined,
      lastCheckedAt: this.lastCheckedAt !== undefined
        ? new Date(this.lastCheckedAt).toISOString()
        : undefined,
      blockedUntil: this.blockedUntil !== undefined
        ? new Date(this.blockedUntil).toISOString()
        : undefined,
      lastError: this.lastError,
      runtime: this.runtimeStatus,
    };
  }

  getClient(): Promise<TClient> {
    return this.serialize(async () => {
      if (this.client && !this.unhealthyClients.has(this.client)) {
        return this.client;
      }

      const now = this.now();
      if (this.blockedUntil && now < this.blockedUntil) {
        throw new CopilotRuntimeResetLimitError(this.blockedUntil);
      }
      this.blockedUntil = undefined;
      this.state = "starting";
      this.runtimeStatus = undefined;

      const client = this.createClient();
      if (this.timedOutStartups.has(client)) {
        this.state = "failed";
        throw new Error("Cannot reuse a Copilot SDK client whose startup timed out.");
      }
      this.cleanupStarted.delete(client);
      const startup = Promise.resolve().then(() => client.start());
      try {
        await withRuntimeDeadline(() => startup, "startup", this.startupTimeoutMs);
      } catch (startError) {
        if (startError instanceof CopilotRuntimeDeadlineError) {
          this.timedOutStartups.add(client);
          // A timeout cannot retract startup. If it completes late, retire that
          // exact client again without touching the replacement generation.
          void startup.then(
            () => this.stopClient(client),
            () => {},
          ).catch(() => {});
        }
        this.state = "failed";
        this.lastError = errorMessage(startError);
        try {
          await this.stopClient(client);
        } catch (cleanupError) {
          throw new AggregateError(
            [asError(startError), asError(cleanupError)],
            "Copilot SDK startup and cleanup failed"
          );
        }
        throw startError;
      }

      this.client = client;
      this.generation++;
      this.clientGeneration.set(client, this.generation);
      this.activeOperations.set(client, 0);
      this.state = "ready";
      this.startedAt = this.now();
      this.lastError = undefined;
      return client;
    });
  }

  async acquireClient(): Promise<CopilotRuntimeLease<TClient>> {
    let client: TClient;
    let generation: number | null;
    do {
      client = await this.getClient();
      generation = await this.serialize(async () => {
        if (client !== this.client || this.unhealthyClients.has(client)) {
          return null;
        }
        this.activeOperations.set(
          client,
          (this.activeOperations.get(client) ?? 0) + 1
        );
        return this.clientGeneration.get(client)!;
      });
    } while (generation === null);
    let released = false;
    return {
      client,
      generation,
      // Explicit lease invalidation is an ownership/lifecycle decision. Callers
      // already classify ordinary domain failures before invoking it; unresolved
      // cleanup timeouts must also be able to retire this exact generation.
      invalidate: (reason) => this.reset(client, reason, generation),
      release: async () => {
        if (released) return;
        released = true;
        await this.releaseClient(client, generation);
      },
    };
  }

  reset(
    failedClient: TClient | undefined,
    reason: unknown,
    expectedGeneration?: number,
  ): Promise<boolean> {
    return this.serialize(async () => {
      if (!failedClient ||
          (expectedGeneration !== undefined &&
            this.clientGeneration.get(failedClient) !== expectedGeneration) ||
          (failedClient !== this.client &&
            !this.unhealthyClients.has(failedClient))) {
        return false;
      }
      if (this.unhealthyClients.has(failedClient)) return false;

      const now = this.now();
      this.resetTimes = this.resetTimes.filter(
        (resetAt) => now - resetAt < this.resetWindowMs
      );
      this.resetTimes.push(now);
      this.restartCount++;
      this.lastError = errorMessage(reason);
      this.unhealthyClients.add(failedClient);
      if (this.client === failedClient) {
        this.state = "resetting";
        this.client = null;
        this.startedAt = undefined;
        this.runtimeStatus = undefined;
      }

      const limitReached = this.resetTimes.length >= this.maxResets;
      if (limitReached) {
        this.blockedUntil = this.resetTimes[0] + this.resetWindowMs;
      }

      let cleanupError: unknown;
      if ((this.activeOperations.get(failedClient) ?? 0) === 0) {
        try {
          await this.cleanupClient(failedClient);
        } catch (error) {
          cleanupError = error;
        }
      }

      if (limitReached) {
        this.state = "failed";
        const limitError = new CopilotRuntimeResetLimitError(this.blockedUntil!);
        this.lastError = limitError.message;
        if (cleanupError) {
          throw new AggregateError(
            [limitError, asError(cleanupError)],
            "Copilot SDK reset limit and cleanup failed"
          );
        }
        throw limitError;
      }

      if (cleanupError) {
        this.state = "failed";
        throw cleanupError;
      }

      if (!this.client) this.state = "stopped";
      return true;
    });
  }

  checkHealth(): Promise<CopilotRuntimeHealth> {
    return this.serialize(async () => {
      if (!this.client) return this.getHealth();

      try {
        const client = this.client;
        const [status, ping] = await withRuntimeDeadline(
          () => Promise.all([client.getStatus(), client.ping("planwerk-health")]),
          "health",
          this.healthTimeoutMs,
        );
        this.lastCheckedAt = this.now();
        this.state = "ready";
        this.lastError = undefined;
        this.runtimeStatus = {
          version: status.version,
          protocolVersion: status.protocolVersion,
          pingTimestamp: ping.timestamp,
        };
        return this.getHealth();
      } catch (error) {
        this.lastCheckedAt = this.now();
        this.state = "failed";
        this.lastError = errorMessage(error);
        this.runtimeStatus = undefined;
        const failedClient = this.client;
        this.client = null;
        this.unhealthyClients.add(failedClient);
        if ((this.activeOperations.get(failedClient) ?? 0) === 0) {
          await this.cleanupClient(failedClient).catch(() => {});
        }
        return this.getHealth();
      }
    });
  }

  shutdown(): Promise<void> {
    return this.serialize(async () => {
      const client = this.client;
      this.client = null;
      this.startedAt = undefined;
      this.blockedUntil = undefined;
      this.resetTimes = [];
      this.runtimeStatus = undefined;

      if (!client) {
        this.state = "stopped";
        return;
      }

      this.state = "stopping";
      try {
        this.unhealthyClients.add(client);
        await this.cleanupClient(client);
        this.state = "stopped";
        this.lastError = undefined;
      } catch (error) {
        this.state = "failed";
        this.lastError = errorMessage(error);
        throw error;
      }
    });
  }

  private serialize<TResult>(operation: () => Promise<TResult>): Promise<TResult> {
    const result = this.transition.then(operation, operation);
    this.transition = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  private releaseClient(client: TClient, generation: number): Promise<void> {
    return this.serialize(async () => {
      if (this.clientGeneration.get(client) !== generation) return;
      const remaining = Math.max(
        0,
        (this.activeOperations.get(client) ?? 0) - 1
      );
      this.activeOperations.set(client, remaining);
      if (remaining === 0 && this.unhealthyClients.has(client)) {
        await this.cleanupClient(client);
      }
    });
  }

  private async cleanupClient(client: TClient): Promise<void> {
    if (this.cleanupStarted.has(client)) return;
    this.cleanupStarted.add(client);
    try {
      await this.stopClient(client);
    } finally {
      this.activeOperations.delete(client);
      this.clientGeneration.delete(client);
      this.unhealthyClients.delete(client);
    }
  }

  private async stopClient(client: TClient): Promise<void> {
    const errors: Error[] = [];
    try {
      errors.push(...(await withSdkCleanupTimeout(
        () => client.stop(),
        "stop",
        { timeoutMs: this.cleanupTimeoutMs },
      )));
    } catch (error) {
      errors.push(asError(error));
    }

    if (errors.length > 0) {
      try {
        await withSdkCleanupTimeout(
          () => client.forceStop(),
          "force-stop",
          { timeoutMs: this.cleanupTimeoutMs },
        );
      } catch (error) {
        errors.push(asError(error));
      }
      throw new AggregateError(errors, "Copilot SDK cleanup failed");
    }
  }
}
