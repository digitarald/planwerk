import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { formatWithOptions } from "node:util";
import { join } from "node:path";
import { DiagnosticLog, LOG_ENTRY_BYTES } from "../../lib/diagnostics/log.ts";

export function createDesktopDiagnostics(dataDir: string, runId: string = randomUUID()) {
  const context = { runId, pid: process.pid };
  const native = new DiagnosticLog(join(dataDir, "desktop.log"), context);
  const webview = new DiagnosticLog(join(dataDir, "webview.log"), context);
  const originals = { ...console };
  const levels = { debug: "DEBUG", log: "INFO", info: "INFO", warn: "WARN", error: "ERROR" } as const;
  for (const method of Object.keys(levels) as Array<keyof typeof levels>) {
    console[method] = (...args: unknown[]) => {
      native.write({
        level: levels[method], scope: "desktop",
        body: formatWithOptions({ depth: 4, maxStringLength: 8000, getters: false }, ...args),
      });
      originals[method](...args);
    };
  }
  const monitor = (error: Error) => native.write({
    level: "FATAL", scope: "desktop:uncaught", body: error.stack ?? error.message,
  });
  process.on("uncaughtExceptionMonitor", monitor);
  return {
    runId,
    native,
    webview,
    dispose() {
      for (const method of Object.keys(levels) as Array<keyof typeof levels>) console[method] = originals[method];
      process.off("uncaughtExceptionMonitor", monitor);
    },
  };
}

export function captureOutput(log: DiagnosticLog, level: string, pid: number | undefined) {
  const decoder = new StringDecoder("utf8");
  let pending = "";
  let discarding = false;
  const emit = (body: string) => log.write({ level, scope: "server", body, childPid: pid });
  const accept = (text: string) => {
    if (discarding) {
      const newline = text.indexOf("\n");
      if (newline < 0) return;
      text = text.slice(newline + 1);
      discarding = false;
    }
    pending += text;
    let newline: number;
    while ((newline = pending.indexOf("\n")) >= 0) {
      emit(pending.slice(0, newline));
      pending = pending.slice(newline + 1);
    }
    if (Buffer.byteLength(pending) > LOG_ENTRY_BYTES) {
      emit(pending);
      pending = "";
      discarding = true;
    }
  };
  return {
    write(chunk: Buffer) { accept(decoder.write(chunk)); },
    end() {
      accept(decoder.end());
      if (pending) emit(pending);
      pending = "";
    },
  };
}
