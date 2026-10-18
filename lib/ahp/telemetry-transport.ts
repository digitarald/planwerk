import "server-only";

import type { AhpTransport, TransportFrame, JsonRpcMessage } from "@microsoft/agent-host-protocol/client";

/**
 * Notification payload extracted from an inbound OTLP frame.
 * `method` is e.g. "otlp/exportLogs", "otlp/exportTraces", "otlp/exportMetrics".
 */
export interface OtlpNotification {
  method: string;
  params: { channel: string; payload: Record<string, unknown> };
}

export type OtlpNotificationHandler = (notification: OtlpNotification) => void;

/**
 * Transport wrapper that tees inbound `otlp/*` notifications to a callback
 * before passing every frame through to the real transport consumer (AhpClient).
 *
 * The SDK currently drops OTLP notifications in its `handleNotification()`
 * default case. This wrapper lets us capture them without modifying the SDK.
 */
export class TelemetryTapTransport implements AhpTransport {
  private readonly inner: AhpTransport;
  private readonly onOtlp: OtlpNotificationHandler;

  constructor(
    inner: AhpTransport,
    onOtlp: OtlpNotificationHandler
  ) {
    this.inner = inner;
    this.onOtlp = onOtlp;
  }

  send(message: JsonRpcMessage | string): Promise<void> | void {
    return this.inner.send(message);
  }

  async recv(): Promise<TransportFrame | null> {
    const frame = await this.inner.recv();
    if (frame) this.inspectFrame(frame);
    return frame;
  }

  close(): Promise<void> | void {
    return this.inner.close();
  }

  private inspectFrame(frame: TransportFrame): void {
    try {
      let method: string | undefined;
      let params: unknown;

      if (frame.kind === "parsed") {
        const msg = frame.message as { method?: string; params?: unknown };
        method = msg.method;
        params = msg.params;
      } else {
        const text = frame.kind === "text"
          ? frame.text
          : new TextDecoder("utf-8").decode(frame.data);
        // Quick check before full parse — skip frames that can't be OTLP
        if (!text.includes('"otlp/')) return;
        const parsed = JSON.parse(text) as { method?: string; params?: unknown };
        method = parsed.method;
        params = parsed.params;
      }

      if (method?.startsWith("otlp/") && params) {
        this.onOtlp({
          method,
          params: params as OtlpNotification["params"],
        });
      }
    } catch (error) {
      console.warn("[ahp:telemetry] Could not inspect host telemetry:", error);
    }
  }
}
