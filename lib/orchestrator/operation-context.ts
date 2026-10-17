import { AsyncLocalStorage } from "node:async_hooks";

import { OperationAbortedError, throwIfAborted } from "../abort.ts";
import type { CoordinatorCapability } from "./coordinator-mode.ts";
import type { OperationLease } from "./operation-admission.ts";

export interface OperationContext {
  readonly signal: AbortSignal;
  readonly hostUrl: string;
  readonly cardId: string;
  readonly lease: OperationLease;
  /** Reads current mode, scope, host generation, and source, not captured permission. */
  isCurrent(capability: CoordinatorCapability): boolean;
}

const storage = new AsyncLocalStorage<OperationContext>();

export function withOperationContext<T>(
  context: OperationContext,
  operation: () => T,
): T {
  return storage.run(context, operation);
}

export function getOperationSignal(): AbortSignal | undefined {
  return storage.getStore()?.signal;
}

export function assertOperationCurrent(
  capability: CoordinatorCapability = "observe",
  target?: { hostUrl?: string; cardId?: string },
): void {
  const context = storage.getStore();
  if (!context) return;
  throwIfAborted(context.signal);
  if (
    (target?.hostUrl !== undefined && target.hostUrl !== context.hostUrl) ||
    (target?.cardId !== undefined && target.cardId !== context.cardId)
  ) {
    throw new OperationAbortedError("Operation target does not match its admitted host/session.");
  }
  if (!context.isCurrent(capability)) {
    throw new OperationAbortedError("Operation authority or source changed.");
  }
}

export async function runOperationEffect<T>(
  capability: CoordinatorCapability,
  operation: () => Promise<T>,
): Promise<T> {
  assertOperationCurrent(capability);
  const context = storage.getStore();
  if (!context) return operation();
  return context.lease.effect(operation);
}
