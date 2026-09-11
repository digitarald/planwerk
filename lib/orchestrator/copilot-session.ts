import type { CopilotClient, CopilotSession } from "@github/copilot-sdk";

import {
  classifyCopilotFailure,
  isCopilotRuntimeInvalidatingFailure,
  type CopilotRuntimeLease,
} from "./sdk-runtime-manager.ts";

type SessionOwner = Pick<CopilotClient, "deleteSession">;
type DisposableSession = Pick<
  CopilotSession,
  "sessionId" | "abort" | "disconnect"
>;
type DisconnectableSession = Pick<CopilotSession, "abort" | "disconnect">;

export type CopilotCleanupOperation =
  | "abort"
  | "clear"
  | "delete"
  | "disconnect"
  | "quarantine"
  | "restore"
  | "renew-lease"
  | "release-lease";

export interface CopilotCleanupFailure {
  operation: CopilotCleanupOperation;
  error: unknown;
}

export interface CopilotCleanupReport {
  failures: CopilotCleanupFailure[];
}

function logCleanupFailure(
  logPrefix: string,
  operation: CopilotCleanupOperation,
  error: unknown,
): void {
  console.warn(
    `${logPrefix} Failed to ${
      operation === "release-lease"
        ? "release SQLite lease"
        : operation === "clear"
          ? "clear quarantined Copilot SDK session binding"
          : operation === "renew-lease"
            ? "renew SQLite lease"
            : operation === "quarantine"
              ? "quarantine Copilot SDK session"
              : operation === "restore"
                ? "restore Copilot SDK session binding"
                : `${operation} Copilot SDK session`
    }:`,
    error instanceof Error ? error.message : error,
  );
}

export function addCleanupFailure(
  report: CopilotCleanupReport,
  operation: CopilotCleanupOperation,
  error: unknown,
  logPrefix: string,
): void {
  report.failures.push({ operation, error });
  logCleanupFailure(logPrefix, operation, error);
}

export function getTransportCleanupFailure(
  report: CopilotCleanupReport,
): CopilotCleanupFailure | undefined {
  return report.failures.find(
    ({ error }) => classifyCopilotFailure(error) === "transport",
  );
}

export function getRuntimeInvalidatingCleanupFailure(
  report: CopilotCleanupReport,
): CopilotCleanupFailure | undefined {
  return report.failures.find(
    ({ error }) => isCopilotRuntimeInvalidatingFailure(error),
  );
}

export async function invalidateRuntimeForCleanupFailure<TClient>(
  runtimeLease: CopilotRuntimeLease<TClient>,
  report: CopilotCleanupReport,
  logPrefix: string,
): Promise<boolean> {
  const failure = getRuntimeInvalidatingCleanupFailure(report);
  if (!failure) return false;

  try {
    return await runtimeLease.invalidate(failure.error);
  } catch (error) {
    console.warn(
      `${logPrefix} Failed to invalidate Copilot SDK runtime after ${failure.operation} failure:`,
      error instanceof Error ? error.message : error,
    );
    return false;
  }
}

export async function releaseRuntimeLease(
  runtimeLease: Pick<CopilotRuntimeLease<unknown>, "release"> | undefined,
  logPrefix: string,
): Promise<unknown | undefined> {
  try {
    await runtimeLease?.release();
    return undefined;
  } catch (error) {
    console.warn(
      `${logPrefix} Failed to release Copilot SDK runtime lease:`,
      error instanceof Error ? error.message : error,
    );
    return error;
  }
}

export async function disconnectCopilotSession(
  session: DisconnectableSession,
  abortInFlight: boolean,
  logPrefix: string,
): Promise<CopilotCleanupReport> {
  const report: CopilotCleanupReport = { failures: [] };
  if (abortInFlight) {
    try {
      await session.abort();
    } catch (error) {
      addCleanupFailure(report, "abort", error, logPrefix);
    }
  }

  try {
    await session.disconnect();
  } catch (error) {
    addCleanupFailure(report, "disconnect", error, logPrefix);
  }
  return report;
}

export async function disposeOneShotSession(
  client: SessionOwner,
  session: DisposableSession,
  abortInFlight: boolean,
  logPrefix: string,
): Promise<CopilotCleanupReport> {
  const report: CopilotCleanupReport = { failures: [] };
  if (abortInFlight) {
    try {
      await session.abort();
    } catch (error) {
      addCleanupFailure(report, "abort", error, logPrefix);
    }
  }

  try {
    await client.deleteSession(session.sessionId);
  } catch (error) {
    addCleanupFailure(report, "delete", error, logPrefix);
    try {
      await session.disconnect();
    } catch (disconnectError) {
      addCleanupFailure(report, "disconnect", disconnectError, logPrefix);
    }
  }
  return report;
}
