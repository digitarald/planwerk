export const webviewDiagnosticsPreload = `
(() => {
  const describe = (value) => {
    if (value instanceof Error) return value.stack || value.message;
    if (typeof value === "string") return value;
    if (value === null || ["number", "boolean", "undefined"].includes(typeof value)) return String(value);
    return "[object omitted]";
  };
  let remaining = 60;
  let resetAt = Date.now() + 60000;
  let dropped = 0;
  const send = (level, scope, body) => {
    if (Date.now() >= resetAt) {
      remaining = 60;
      resetAt = Date.now() + 60000;
      if (dropped) {
        window.__electrobunSendToHost({ type: "diagnostic", level: "WARN", scope: "rate-limit", body: dropped + " browser diagnostics suppressed" });
        dropped = 0;
      }
    }
    if (remaining-- <= 0) { dropped++; return; }
    window.__electrobunSendToHost({ type: "diagnostic", level, scope, body: body.slice(0, 8000) });
  };
  for (const method of ["warn", "error"]) {
    const original = console[method].bind(console);
    console[method] = (...args) => {
      original(...args);
      send(method === "warn" ? "WARN" : "ERROR", "console", args.map(describe).join(" "));
    };
  }
  window.addEventListener("error", (event) => {
    if (event instanceof ErrorEvent) send("ERROR", "error", describe(event.error || event.message));
    else send("ERROR", "resource", "A browser resource failed to load");
  }, true);
  window.addEventListener("unhandledrejection", (event) => send("ERROR", "unhandledrejection", describe(event.reason)));
})();
`;

export function webviewDiagnostic(detail: unknown): { level: string; scope: string; body: string } | null {
  if (!detail || typeof detail !== "object") return null;
  const value = detail as Record<string, unknown>;
  if (value.type !== "diagnostic" || !["WARN", "ERROR"].includes(String(value.level))
    || !["console", "error", "resource", "unhandledrejection", "rate-limit"].includes(String(value.scope))
    || typeof value.body !== "string" || value.body.length > 8000) return null;
  return { level: String(value.level), scope: `webview:${String(value.scope)}`, body: value.body };
}

export function createWebviewDiagnosticHandler(write: (record: { level: string; scope: string; body: string }) => unknown) {
  let start = Date.now();
  let received = 0;
  return (detail: unknown) => {
    const record = webviewDiagnostic(detail);
    if (!record) return;
    if (Date.now() - start >= 60_000) { start = Date.now(); received = 0; }
    received++;
    if (received <= 61) write(record);
    else if (received === 62) write({ level: "WARN", scope: "webview:rate-limit", body: "Host suppressed excess browser diagnostics" });
  };
}
