import { randomUUID } from "node:crypto";

import type {
  CopilotSession,
  ResumeSessionConfig,
  SessionConfig,
} from "@github/copilot-sdk";

import type { CtoContinuityStore } from "../db/cto-continuity-store.ts";
import {
  addCleanupFailure,
  disconnectCopilotSession,
  type CopilotCleanupReport,
} from "./copilot-session.ts";
import { runLeaseRenewalTick } from "./lease-renewal.ts";

type ManagedSession = Pick<
  CopilotSession,
  "sessionId" | "abort" | "disconnect" | "on" | "sendAndWait"
>;

export interface CtoSessionClient {
  createSession(config: SessionConfig): Promise<ManagedSession>;
  resumeSession(
    sessionId: string,
    config: ResumeSessionConfig
  ): Promise<ManagedSession>;
  getSessionMetadata(sessionId: string): Promise<unknown | undefined>;
  deleteSession(sessionId: string): Promise<void>;
}

export class CtoSessionLeaseBusyError extends Error {
  constructor() {
    super("The CTO session is already active in another request");
    this.name = "CtoSessionLeaseBusyError";
  }
}

export class CtoSessionLeaseLostError extends Error {
  constructor(cause?: unknown) {
    super("The CTO session lease could not be renewed", { cause });
    this.name = "CtoSessionLeaseLostError";
  }
}

export class CtoSessionCleanupTimeoutError extends Error {
  readonly code = "CTO_SESSION_CLEANUP_TIMEOUT";

  constructor(operation: "delete" | "disconnect", timeoutMs: number) {
    super(
      `Copilot SDK session ${operation} exceeded the ${timeoutMs}ms cleanup timeout`,
    );
    this.name = "CtoSessionCleanupTimeoutError";
  }
}

export interface CtoLeaseRenewalScheduler {
  set(callback: () => void, delayMs: number): unknown;
  clear(handle: unknown): void;
}

const defaultRenewalScheduler: CtoLeaseRenewalScheduler = {
  set(callback, delayMs) {
    const timer = setInterval(callback, delayMs);
    timer.unref();
    return timer;
  },
  clear(handle) {
    clearInterval(handle as ReturnType<typeof setInterval>);
  },
};

export interface CtoSessionHandle {
  session: ManagedSession;
  resumed: boolean;
  release(options?: { abort?: boolean }): Promise<CopilotCleanupReport>;
}

export interface CtoSessionOpenOptions {
  invalidateRuntime?: (reason: unknown) => Promise<unknown>;
}

export class CtoSessionManager {
  private readonly store: CtoContinuityStore;
  private readonly leaseTtlMs: number;
  private readonly invalidSessionError: (error: unknown) => boolean;
  private readonly renewalScheduler: CtoLeaseRenewalScheduler;
  private readonly cleanupTimeoutMs: number;

  constructor(
    store: CtoContinuityStore,
    leaseTtlMs = 120_000,
    invalidSessionError = (error: unknown) =>
      error instanceof Error &&
      /\b(not found|does not exist|invalid session|unknown session)\b/i.test(
        error.message
      ),
    renewalScheduler: CtoLeaseRenewalScheduler = defaultRenewalScheduler,
    cleanupTimeoutMs?: number,
  ) {
    this.store = store;
    this.leaseTtlMs = leaseTtlMs;
    this.invalidSessionError = invalidSessionError;
    this.renewalScheduler = renewalScheduler;
    if (leaseTtlMs <= 1) {
      throw new RangeError("CTO session lease TTL must be greater than 1ms");
    }
    this.cleanupTimeoutMs = Math.max(
      1,
      Math.min(cleanupTimeoutMs ?? 30_000, leaseTtlMs - 1),
    );
  }

  private async withCleanupTimeout<T>(
    operation: Promise<T>,
    name: "delete" | "disconnect",
  ): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(
              new CtoSessionCleanupTimeoutError(name, this.cleanupTimeoutMs),
            ),
            this.cleanupTimeoutMs,
          );
          timer.unref();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private assertLease(ownerId: string, leaseState: { failure?: unknown }): void {
    if (
      leaseState.failure !== undefined ||
      !this.store.hasLease("primary", ownerId)
    ) {
      throw new CtoSessionLeaseLostError(leaseState.failure);
    }
  }

  private quarantineForCleanup(
    sessionId: string,
    ownerId: string,
    report: CopilotCleanupReport,
  ): string | undefined {
    const deletionToken = randomUUID();
    try {
      if (!this.store.quarantineSessionForDeletion(
        sessionId,
        "primary",
        ownerId,
        deletionToken,
      )) {
        throw new CtoSessionLeaseLostError();
      }
      return deletionToken;
    } catch (error) {
      addCleanupFailure(
        report,
        "quarantine",
        error,
        "[cto-session-manager]",
      );
      return undefined;
    }
  }

  private async cleanupResumedOpenFailure(
    session: ManagedSession,
    ownerId: string,
  ): Promise<CopilotCleanupReport> {
    const report: CopilotCleanupReport = { failures: [] };
    const deletionToken = this.quarantineForCleanup(
      session.sessionId,
      ownerId,
      report,
    );
    if (!deletionToken) return report;

    try {
      const disconnected = await this.withCleanupTimeout(
        disconnectCopilotSession(
          session,
          true,
          "[cto-session-manager]",
        ),
        "disconnect",
      );
      report.failures.push(...disconnected.failures);
    } catch (error) {
      addCleanupFailure(
        report,
        "disconnect",
        error,
        "[cto-session-manager]",
      );
    }

    if (report.failures.length === 0) {
      try {
        if (!this.store.restoreQuarantinedSession(
          session.sessionId,
          deletionToken,
          "primary",
          ownerId,
        )) {
          throw new CtoSessionLeaseLostError();
        }
      } catch (error) {
        addCleanupFailure(
          report,
          "restore",
          error,
          "[cto-session-manager]",
        );
      }
    }
    return report;
  }

  private async cleanupCreatedOpenFailure(
    client: CtoSessionClient,
    session: ManagedSession,
    ownerId: string,
  ): Promise<CopilotCleanupReport> {
    const report: CopilotCleanupReport = { failures: [] };
    let deletionToken: string | undefined;
    try {
      const binding = this.store.getSessionBinding();
      if (binding?.sessionId === session.sessionId) {
        deletionToken = this.quarantineForCleanup(
          session.sessionId,
          ownerId,
          report,
        );
        if (!deletionToken) return report;
      }
    } catch (error) {
      addCleanupFailure(
        report,
        "quarantine",
        error,
        "[cto-session-manager]",
      );
      return report;
    }

    try {
      await this.withCleanupTimeout(
        client.deleteSession(session.sessionId),
        "delete",
      );
      if (deletionToken) {
        try {
          if (!this.store.clearQuarantinedSession(
            session.sessionId,
            deletionToken,
            "primary",
            ownerId,
          )) {
            throw new CtoSessionLeaseLostError();
          }
        } catch (error) {
          addCleanupFailure(
            report,
            "clear",
            error,
            "[cto-session-manager]",
          );
        }
      }
    } catch (error) {
      addCleanupFailure(
        report,
        "delete",
        error,
        "[cto-session-manager]",
      );
      try {
        const fallback = await this.withCleanupTimeout(
          disconnectCopilotSession(
            session,
            true,
            "[cto-session-manager]",
          ),
          "disconnect",
        );
        report.failures.push(...fallback.failures);
      } catch (disconnectError) {
        addCleanupFailure(
          report,
          "disconnect",
          disconnectError,
          "[cto-session-manager]",
        );
      }
    }
    return report;
  }

  private async reconcileDeletion(
    client: CtoSessionClient,
    sessionId: string,
    ownerId: string,
    leaseState: { failure?: unknown },
  ): Promise<void> {
    const deletionToken = randomUUID();
    if (!this.store.quarantineSessionForDeletion(
      sessionId,
      "primary",
      ownerId,
      deletionToken,
    )) {
      throw new CtoSessionLeaseLostError();
    }
    try {
      await this.withCleanupTimeout(
        client.deleteSession(sessionId),
        "delete",
      );
    } catch (error) {
      if (!this.invalidSessionError(error)) throw error;
    }
    this.assertLease(ownerId, leaseState);
    if (!this.store.clearQuarantinedSession(
        sessionId,
        deletionToken,
        "primary",
        ownerId,
    )) {
      throw new CtoSessionLeaseLostError();
    }
  }

  async open(
    client: CtoSessionClient,
    modelId: string,
    config: SessionConfig,
    options: CtoSessionOpenOptions = {},
  ): Promise<CtoSessionHandle> {
    const ownerId = randomUUID();
    if (!this.store.acquireLease("primary", ownerId, this.leaseTtlMs)) {
      throw new CtoSessionLeaseBusyError();
    }
    let activeSession: ManagedSession | undefined;
    let createdSession = false;
    const leaseState: { failure?: unknown } = {};
    const renewalTimer = this.renewalScheduler.set(() => {
      runLeaseRenewalTick(
        leaseState,
        () => this.store.renewLease(
          "primary",
          ownerId,
          this.leaseTtlMs,
        ),
        () => {
          void activeSession?.abort().catch((abortError) => {
            console.warn(
              "[cto-session-manager] Failed to abort after lease renewal failure:",
              abortError instanceof Error ? abortError.message : abortError,
            );
          });
        },
        new CtoSessionLeaseLostError().message,
      );
    }, Math.max(1, Math.floor(this.leaseTtlMs / 3)));

    try {
      const persistedBinding = this.store.getSessionBinding();
      if (persistedBinding?.lifecycleState === "deleting") {
        await this.reconcileDeletion(
          client,
          persistedBinding.sessionId,
          ownerId,
          leaseState,
        );
      }
      const persisted = this.store.getSession();
      let session: ManagedSession | undefined;
      let resumed = false;

      if (persisted?.sessionId) {
        const metadata = await client.getSessionMetadata(persisted.sessionId);
        this.assertLease(ownerId, leaseState);
        if (!metadata) {
          if (!this.store.clearSessionIfLeaseOwner(
            persisted.sessionId,
            "primary",
            ownerId,
          )) {
            throw new CtoSessionLeaseLostError();
          }
        } else {
          try {
            session = await client.resumeSession(
              persisted.sessionId,
              config as ResumeSessionConfig
            );
            activeSession = session;
            this.assertLease(ownerId, leaseState);
            resumed = true;
          } catch (error) {
            if (!this.invalidSessionError(error)) throw error;
            this.assertLease(ownerId, leaseState);
            if (!this.store.clearSessionIfLeaseOwner(
              persisted.sessionId,
              "primary",
              ownerId,
            )) {
              throw new CtoSessionLeaseLostError();
            }
          }
        }
      }

      if (!session) {
        session = await client.createSession(config);
        activeSession = session;
        this.assertLease(ownerId, leaseState);
        createdSession = true;
      }
      this.assertLease(ownerId, leaseState);
      if (!this.store.setSessionIfLeaseOwner(
        session.sessionId,
        modelId,
        "primary",
        ownerId,
      )) {
        throw new CtoSessionLeaseLostError();
      }

      let releasePromise: Promise<CopilotCleanupReport> | undefined;
      return {
        session,
        resumed,
        release: ({ abort = false } = {}) => {
          if (releasePromise) return releasePromise;
          releasePromise = (async () => {
            const report: CopilotCleanupReport = { failures: [] };
            const deletionToken = randomUUID();
            let quarantined = false;
            try {
              quarantined = this.store.quarantineSessionForDeletion(
                session.sessionId,
                "primary",
                ownerId,
                deletionToken,
              );
              if (!quarantined) {
                throw new CtoSessionLeaseLostError();
              }
            } catch (error) {
              addCleanupFailure(
                report,
                "quarantine",
                error,
                "[cto-session-manager]",
              );
            }

            if (quarantined) {
              try {
                const disconnected = await this.withCleanupTimeout(
                  disconnectCopilotSession(
                    session,
                    abort,
                    "[cto-session-manager]",
                  ),
                  "disconnect",
                );
                report.failures.push(...disconnected.failures);
              } catch (error) {
                addCleanupFailure(
                  report,
                  "disconnect",
                  error,
                  "[cto-session-manager]",
                );
              }

              if (report.failures.length === 0) {
                try {
                  if (!this.store.restoreQuarantinedSession(
                    session.sessionId,
                    deletionToken,
                    "primary",
                    ownerId,
                  )) {
                    addCleanupFailure(
                      report,
                      "restore",
                      new CtoSessionLeaseLostError(),
                      "[cto-session-manager]",
                    );
                  }
                } catch (restoreError) {
                  addCleanupFailure(
                    report,
                    "restore",
                    restoreError,
                    "[cto-session-manager]",
                  );
                }
              }
            }

            if (leaseState.failure !== undefined) {
              addCleanupFailure(
                report,
                "renew-lease",
                new CtoSessionLeaseLostError(leaseState.failure),
                "[cto-session-manager]",
              );
            }

            const unconfirmedDisconnect = report.failures[0];
            if (unconfirmedDisconnect && options.invalidateRuntime) {
              await options.invalidateRuntime(unconfirmedDisconnect.error).catch(
                (invalidationError) => {
                  console.warn(
                    "[cto-session-manager] Failed to retire unconfirmed disconnect runtime:",
                    invalidationError instanceof Error
                      ? invalidationError.message
                      : invalidationError,
                  );
                },
              );
            }
            try {
              this.store.releaseLease("primary", ownerId);
            } catch (error) {
              addCleanupFailure(
                report,
                "release-lease",
                error,
                "[cto-session-manager]",
              );
            } finally {
              this.renewalScheduler.clear(renewalTimer);
            }
            return report;
          })();
          return releasePromise;
        },
      };
    } catch (error) {
      if (
        !activeSession &&
        error instanceof CtoSessionCleanupTimeoutError &&
        options.invalidateRuntime
      ) {
        await options.invalidateRuntime(error).catch((cleanupError) => {
          console.warn(
            "[cto-session-manager] Failed to invalidate timed-out deletion runtime:",
            cleanupError instanceof Error ? cleanupError.message : cleanupError,
          );
        });
      }
      if (activeSession) {
        const cleanup = createdSession
          ? await this.cleanupCreatedOpenFailure(
              client,
              activeSession,
              ownerId,
            )
          : await this.cleanupResumedOpenFailure(activeSession, ownerId);
        const invalidationReason = cleanup.failures[0]?.error;
        if (invalidationReason !== undefined && options.invalidateRuntime) {
          await options.invalidateRuntime(invalidationReason).catch(
            (cleanupError) => {
              console.warn(
                "[cto-session-manager] Failed to invalidate Copilot SDK runtime:",
                cleanupError instanceof Error
                  ? cleanupError.message
                  : cleanupError,
              );
            },
          );
        }
      }
      try {
        this.store.releaseLease("primary", ownerId);
      } catch (leaseError) {
        console.warn(
          "[cto-session-manager] Failed to release SQLite lease after open failure:",
          leaseError instanceof Error ? leaseError.message : leaseError,
        );
      } finally {
        this.renewalScheduler.clear(renewalTimer);
      }
      throw error;
    }
  }

  async clear(
    client: CtoSessionClient,
    options: CtoSessionOpenOptions = {},
  ): Promise<boolean> {
    const ownerId = randomUUID();
    if (!this.store.acquireLease("primary", ownerId, this.leaseTtlMs)) {
      throw new CtoSessionLeaseBusyError();
    }
    const leaseState: { failure?: unknown } = {};
    const renewalTimer = this.renewalScheduler.set(() => {
      runLeaseRenewalTick(
        leaseState,
        () => this.store.renewLease("primary", ownerId, this.leaseTtlMs),
        () => {},
        new CtoSessionLeaseLostError().message,
      );
    }, Math.max(1, Math.floor(this.leaseTtlMs / 3)));
    try {
      const persisted = this.store.getSessionBinding();
      if (!persisted) return false;
      await this.reconcileDeletion(
        client,
        persisted.sessionId,
        ownerId,
        leaseState,
      );
      return true;
    } catch (error) {
      if (
        error instanceof CtoSessionCleanupTimeoutError &&
        options.invalidateRuntime
      ) {
        await options.invalidateRuntime(error).catch((cleanupError) => {
          console.warn(
            "[cto-session-manager] Failed to invalidate timed-out deletion runtime:",
            cleanupError instanceof Error ? cleanupError.message : cleanupError,
          );
        });
      }
      throw error;
    } finally {
      try {
        this.store.releaseLease("primary", ownerId);
      } finally {
        this.renewalScheduler.clear(renewalTimer);
      }
    }
  }
}
