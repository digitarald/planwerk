import assert from "node:assert/strict";
import test from "node:test";
import { createWebviewPerformanceHandler } from "./webview-performance.ts";
import { createWebviewDiagnosticHandler } from "./webview-diagnostics.ts";
import type { LogRecord } from "../../lib/diagnostics/log.ts";

test("performance traffic has a separate bounded native allowance from browser errors", () => {
  const records: LogRecord[] = [];
  const performance = createWebviewPerformanceHandler((record) => records.push(record));
  const errors = createWebviewDiagnosticHandler((record) => records.push(record));
  const batch = {
    type: "performance", documentId: "test-document", timeOrigin: 100, dropped: 2,
    records: [{ name: "timer-lag", kind: "stall", startMs: 1000, durationMs: 250 }],
  };
  performance({ ...batch, secret: "must-not-be-persisted" });
  assert.equal(records.length, 0);
  for (let index = 0; index < 100; index++) performance(batch);
  assert.equal(records.length, 25);
  assert.equal(records[0].documentId, "test-document");
  assert.equal(records[0].dropped, 2);
  assert.equal(records.at(-1)?.level, "WARN");
  errors({ type: "diagnostic", level: "ERROR", scope: "console", body: "still captured" });
  assert.equal(records.at(-1)?.body, "still captured");
  assert.equal(records.length, 26);
});
