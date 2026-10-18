import { closeSync, constants, fstatSync, mkdirSync, openSync, renameSync, rmSync, writeSync } from "node:fs";
import { dirname } from "node:path";

export const LOG_MAX_BYTES = 2 * 1024 * 1024;
export const LOG_BACKUPS = 2;
export const LOG_ENTRY_BYTES = 16 * 1024;

export function redactLogText(text: string, secrets: readonly string[] = []): string {
  let result = text;
  for (const secret of secrets) {
    if (secret) result = result.split(secret).join("[REDACTED]");
  }
  return result
    .replace(/\b(Bearer|Basic)\s+[^\s"',;]+/gi, "$1 [REDACTED]")
    .replace(/\b((?:gh[pousr]_|github_pat_)[a-zA-Z0-9_]+)\b/g, "[REDACTED]")
    .replace(/((?:token|password|secret|authorization|api[_-]?key)["']?\s*[:=]\s*["']?)[^\s"',;&}]+/gi, "$1[REDACTED]")
    .replace(/(https?:\/\/)[^/\s:@]+:[^/\s@]+@/gi, "$1[REDACTED]@");
}

export interface LogRecord {
  level: string;
  scope: string;
  body: string;
  [key: string]: unknown;
}

function missing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/** Each file has one owning process. Open per write so rotation never leaves a stale descriptor. */
export class DiagnosticLog {
  private failed = false;
  private directoryReady = false;
  readonly path: string;
  private readonly context: Record<string, string | number>;
  private readonly secrets: readonly string[];
  private readonly maxBytes: number;
  private readonly reportFailure: (message: string) => void;

  constructor(
    path: string,
    context: Record<string, string | number> = {},
    secrets: readonly string[] = [],
    maxBytes = LOG_MAX_BYTES,
    reportFailure: (message: string) => void = (message) => process.stderr.write(`${message}\n`),
  ) {
    this.path = path;
    this.context = context;
    this.secrets = secrets;
    this.maxBytes = maxBytes;
    this.reportFailure = reportFailure;
  }

  write(record: LogRecord): boolean {
    try {
      if (!this.directoryReady) {
        mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
        this.directoryReady = true;
      }
      const clean = JSON.parse(JSON.stringify(record, (key, value: unknown) => {
        if (/^(?:token|password|secret|authorization|api[_-]?key)$/i.test(key)) return "[REDACTED]";
        return typeof value === "string" ? redactLogText(value, this.secrets) : value;
      })) as LogRecord;
      let line = JSON.stringify({
        ...clean, ...this.context, ts: clean.ts ?? new Date().toISOString(),
        recordedAt: new Date().toISOString(),
      });
      if (Buffer.byteLength(line) > LOG_ENTRY_BYTES) {
        const correlation: Record<string, string> = {};
        for (const key of ["session", "sdkSessionId", "cardId", "turnId", "toolCallId", "agentId"]) {
          if (typeof clean[key] === "string") correlation[key] = clean[key].slice(0, 256);
        }
        line = JSON.stringify({
          ...correlation, ...this.context,
          ts: typeof clean.ts === "string" ? clean.ts.slice(0, 64) : new Date().toISOString(),
          recordedAt: new Date().toISOString(), level: clean.level,
          scope: clean.scope.slice(0, 128), body: clean.body.slice(0, 2000),
          truncated: true,
        });
      }
      const bytes = Buffer.from(`${line}\n`);
      let fd: number | undefined = this.open();
      try {
        if (fstatSync(fd).size + bytes.length > this.maxBytes) {
          closeSync(fd);
          fd = undefined;
          this.rotate();
          fd = this.open();
        }
        let offset = 0;
        while (offset < bytes.length) {
          const written = writeSync(fd, bytes, offset);
          if (written === 0) throw new Error("Log write made no progress");
          offset += written;
        }
      } finally {
        if (fd !== undefined) closeSync(fd);
      }
      this.failed = false;
      return true;
    } catch (error) {
      this.directoryReady = false;
      if (!this.failed) {
        this.failed = true;
        this.reportFailure(`[diagnostics] Log write failed: ${redactLogText(String(error), this.secrets)}`);
      }
      return false;
    }
  }

  private open(): number {
    return openSync(this.path, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
  }

  private rotate(): void {
    rmSync(`${this.path}.${LOG_BACKUPS}`, { force: true });
    for (let index = LOG_BACKUPS - 1; index >= 0; index--) {
      const source = index === 0 ? this.path : `${this.path}.${index}`;
      try {
        renameSync(source, `${this.path}.${index + 1}`);
      } catch (error) {
        if (!missing(error)) throw error;
      }
    }
  }
}
