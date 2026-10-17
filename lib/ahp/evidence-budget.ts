import { throwIfAborted } from "../abort.ts";

export interface EvidenceCaptureLimits {
  maxFiles: number;
  maxDecodedBytes: number;
  timeoutMs: number;
}

export const EVIDENCE_CAPTURE_LIMITS: Readonly<EvidenceCaptureLimits> = {
  maxFiles: 256,
  maxDecodedBytes: 32 * 1024 * 1024,
  timeoutMs: 30_000,
};

export type EvidenceCaptureFailure = "file-limit" | "byte-limit" | "deadline" | "changeset-template";

export class EvidenceCaptureLimitError extends Error {
  readonly detail: EvidenceCaptureFailure;
  constructor(detail: EvidenceCaptureFailure) {
    super(`Evidence capture unavailable: ${detail}`);
    this.name = "EvidenceCaptureLimitError";
    this.detail = detail;
  }
}

/** Limits retained/accepted bytes, not transport transfer: resourceRead has no
 * range/size limit and a single response must arrive before its size is known. */
export class EvidenceCaptureBudget {
  readonly signal: AbortSignal;
  private readonly controller = new AbortController();
  private readonly timer: ReturnType<typeof setTimeout>;
  private decodedBytes = 0;
  private readonly onAbort: () => void;
  private readonly limits: Readonly<EvidenceCaptureLimits>;
  private readonly parentSignal?: AbortSignal;
  private readonly deadline: number;

  constructor(
    limits: Readonly<EvidenceCaptureLimits> = EVIDENCE_CAPTURE_LIMITS,
    parentSignal?: AbortSignal,
  ) {
    for (const value of Object.values(limits)) {
      if (!Number.isSafeInteger(value) || value <= 0) throw new Error("Evidence capture limits must be positive integers");
    }
    throwIfAborted(parentSignal);
    this.limits = limits;
    this.parentSignal = parentSignal;
    this.deadline = Date.now() + limits.timeoutMs;
    this.signal = this.controller.signal;
    this.onAbort = () => this.controller.abort(parentSignal?.reason);
    parentSignal?.addEventListener("abort", this.onAbort, { once: true });
    this.timer = setTimeout(() => this.fail("deadline"), limits.timeoutMs);
  }

  assertCurrent(): void {
    if (!this.signal.aborted && Date.now() >= this.deadline) this.fail("deadline");
    if (this.signal.aborted && this.signal.reason instanceof EvidenceCaptureLimitError) throw this.signal.reason;
    throwIfAborted(this.signal);
  }

  assertFileCount(count: number): void {
    this.assertCurrent();
    if (count > this.limits.maxFiles) this.fail("file-limit");
    this.assertCurrent();
  }

  consumeDecodedBytes(count: number): void {
    this.assertCurrent();
    this.decodedBytes += count;
    if (this.decodedBytes > this.limits.maxDecodedBytes) this.fail("byte-limit");
    this.assertCurrent();
  }

  private fail(detail: EvidenceCaptureFailure): void {
    this.controller.abort(new EvidenceCaptureLimitError(detail));
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.parentSignal?.removeEventListener("abort", this.onAbort);
  }
}
