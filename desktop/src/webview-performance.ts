import { isUiPerformanceBatch } from "../../lib/diagnostics/ui-performance.ts";
import type { LogRecord } from "../../lib/diagnostics/log.ts";

export function createWebviewPerformanceHandler(write: (record: LogRecord) => unknown) {
  let start = Date.now();
  let received = 0;
  return (detail: unknown) => {
    if (!isUiPerformanceBatch(detail)) return;
    if (Date.now() - start >= 60_000) { start = Date.now(); received = 0; }
    received++;
    if (received <= 24) write({
      level: "INFO", scope: "webview:performance", body: "Browser performance samples",
      metric: "ui.performance", documentId: detail.documentId, timeOrigin: detail.timeOrigin,
      records: detail.records, dropped: detail.dropped,
    });
    else if (received === 25) write({
      level: "WARN", scope: "webview:performance", body: "Native receiver suppressed excess performance batches",
    });
  };
}
