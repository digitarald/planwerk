import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { createWebviewDiagnosticHandler, webviewDiagnostic, webviewDiagnosticsPreload } from "./webview-diagnostics.ts";

test("browser diagnostic bridge accepts only bounded, allowlisted log messages", () => {
  assert.deepEqual(webviewDiagnostic({ type: "diagnostic", level: "ERROR", scope: "console", body: "broken", command: "execute" }),
    { level: "ERROR", scope: "webview:console", body: "broken" });
  for (const value of [null, {}, { type: "rpc", level: "ERROR", scope: "console", body: "broken" },
    { type: "diagnostic", level: "INFO", scope: "console", body: "broken" },
    { type: "diagnostic", level: "ERROR", scope: "execute", body: "broken" },
    { type: "diagnostic", level: "ERROR", scope: "console", body: "x".repeat(8001) }]) {
    assert.equal(webviewDiagnostic(value), null);
  }
  const records: unknown[] = [];
  const receive = createWebviewDiagnosticHandler((record) => records.push(record));
  for (let index = 0; index < 1000; index++) receive({ type: "diagnostic", level: "ERROR", scope: "console", body: "repeat" });
  assert.equal(records.length, 62);
});

test("preload captures console, resource errors, and rejections without serializing arbitrary objects", () => {
  const handlers = new Map<string, (event: object) => void>();
  const messages: Array<{ scope: string; body: string }> = [];
  let originalCalls = 0;
  class ErrorEvent {}
  const context = {
    window: {
      addEventListener: (name: string, handler: (event: object) => void) => handlers.set(name, handler),
      __electrobunSendToHost: (message: { scope: string; body: string }) => messages.push(message),
    },
    console: { warn: () => { originalCalls++; }, error: () => { originalCalls++; } },
    ErrorEvent,
  };
  runInNewContext(webviewDiagnosticsPreload, context);
  context.console.error();
  runInNewContext('console.warn("warning", { privateData: "not copied" });', context);
  handlers.get("unhandledrejection")!({ reason: "failed promise" });
  handlers.get("error")!({});
  assert.equal(originalCalls, 2);
  assert.deepEqual(messages.map((message) => message.scope), ["console", "console", "unhandledrejection", "resource"]);
  assert.equal(messages[1].body, "warning [object omitted]");
  assert.equal(messages[2].body, "failed promise");
});
