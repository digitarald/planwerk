export interface OperationLease {
  readonly key: string;
  effect<T>(operation: () => Promise<T>): Promise<T>;
  finish(): void;
  quarantine(): void;
}

/** A cancelled waiter is not evidence that a remote mutation has finished. */
export class OperationAdmission {
  private readonly leases = new Map<string, { pending: number; finished: boolean; quarantined: boolean }>();
  private readonly capacity: number;

  constructor(capacity = 128) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) {
      throw new RangeError("Operation admission capacity must be a positive integer");
    }
    this.capacity = capacity;
  }

  acquire(hostUrl: string, cardId: string): OperationLease | null {
    const key = JSON.stringify([hostUrl, cardId]);
    if (this.leases.has(key) || this.leases.size >= this.capacity) return null;
    const state = { pending: 0, finished: false, quarantined: false };
    this.leases.set(key, state);
    const release = () => {
      if (state.finished && state.pending === 0 && !state.quarantined) {
        this.leases.delete(key);
      }
    };
    return {
      key,
      async effect<T>(operation: () => Promise<T>): Promise<T> {
        if (state.finished || state.quarantined) {
          throw new Error("Operation lease no longer admits mutations");
        }
        state.pending++;
        try {
          const result = await operation();
          if (result && typeof result === "object") {
            const outcome = result as {
              success?: boolean; stale?: boolean; disposition?: string; failureKind?: string;
            };
            const confirmedSafe = outcome.disposition === "retryable" ||
              outcome.failureKind === "pre-dispatch" || outcome.failureKind === "ambiguous-disposed";
            if (
              (outcome.success === false && outcome.stale !== true && !confirmedSafe) ||
              outcome.disposition === "needs-human"
            ) state.quarantined = true;
          }
          return result;
        } catch (error) {
          // A rejected write can have been accepted remotely. Never retry it
          // merely because its caller stopped waiting or its lease expired.
          state.quarantined = true;
          throw error;
        } finally {
          state.pending--;
          release();
        }
      },
      finish() {
        state.finished = true;
        release();
      },
      quarantine() {
        state.quarantined = true;
      },
    };
  }

  isQuarantined(hostUrl: string, cardId: string): boolean {
    const state = this.leases.get(JSON.stringify([hostUrl, cardId]));
    return state !== undefined && (state.quarantined || (state.finished && state.pending > 0));
  }
}
