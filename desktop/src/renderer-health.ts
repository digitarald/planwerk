import { randomUUID } from "node:crypto";

export class RendererHealth {
  private pending?: {
    id: string;
    result: Promise<boolean | null>;
    finish: (responsive: boolean | null) => void;
  };
  private readonly execute: (script: string) => void;
  private readonly timeoutMs: number;

  constructor(execute: (script: string) => void, timeoutMs = 10_000) {
    this.execute = execute;
    this.timeoutMs = timeoutMs;
  }

  check(): Promise<boolean | null> {
    if (this.pending) return this.pending.result;
    const id = randomUUID();
    let finish!: (responsive: boolean | null) => void;
    const result = new Promise<boolean | null>((resolve) => {
      const timer = setTimeout(() => finish(false), this.timeoutMs);
      finish = (responsive) => {
        clearTimeout(timer);
        this.pending = undefined;
        resolve(responsive);
      };
    });
    this.pending = { id, result, finish };
    try {
      this.execute(`if (document.readyState !== "loading") {
  window.__electrobunSendToHost({ type: "renderer-health", id: ${JSON.stringify(id)} });
}`);
    } catch (error) {
      this.cancel();
      return Promise.reject(error);
    }
    return result;
  }

  receive(detail: unknown): void {
    if (!detail || typeof detail !== "object") return;
    const value = detail as Record<string, unknown>;
    if (value.type === "renderer-health" && value.id === this.pending?.id) {
      this.pending?.finish(true);
    }
  }

  cancel(): void {
    this.pending?.finish(null);
  }
}
