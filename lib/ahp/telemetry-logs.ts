import "server-only";

import { appendFile, mkdir, readFile, writeFile } from "fs/promises";
import { existsSync } from "fs";
import path from "path";

import type { OtlpNotification } from "./telemetry-transport";

const TELEMETRY_DIR = path.join(process.cwd(), ".planwerk", "telemetry");
const LOGS_FILE = path.join(TELEMETRY_DIR, "logs.ndjson");
const MAX_LINES = 10_000;

// OTLP severity number bands → human-readable level
const SEVERITY_MAP: Record<number, string> = {};
// 1-4: TRACE, 5-8: DEBUG, 9-12: INFO, 13-16: WARN, 17-20: ERROR, 21-24: FATAL
for (let i = 1; i <= 4; i++) SEVERITY_MAP[i] = "TRACE";
for (let i = 5; i <= 8; i++) SEVERITY_MAP[i] = "DEBUG";
for (let i = 9; i <= 12; i++) SEVERITY_MAP[i] = "INFO";
for (let i = 13; i <= 16; i++) SEVERITY_MAP[i] = "WARN";
for (let i = 17; i <= 20; i++) SEVERITY_MAP[i] = "ERROR";
for (let i = 21; i <= 24; i++) SEVERITY_MAP[i] = "FATAL";

export interface TelemetryLogEntry {
  ts: string;
  level: string;
  session?: string;
  scope?: string;
  body: string;
  attrs?: Record<string, unknown>;
}

let dirEnsured = false;

async function ensureDir(): Promise<void> {
  if (dirEnsured) return;
  if (!existsSync(TELEMETRY_DIR)) {
    await mkdir(TELEMETRY_DIR, { recursive: true });
  }
  dirEnsured = true;
}

/**
 * Truncate the log file to the last MAX_LINES lines.
 * Called once on startup to prevent unbounded growth.
 */
export async function rotateLogs(): Promise<void> {
  await ensureDir();
  if (!existsSync(LOGS_FILE)) return;
  try {
    const content = await readFile(LOGS_FILE, "utf-8");
    const lines = content.split("\n").filter(Boolean);
    if (lines.length > MAX_LINES) {
      const trimmed = lines.slice(-MAX_LINES).join("\n") + "\n";
      await writeFile(LOGS_FILE, trimmed);
    }
  } catch {
    // Non-fatal — file may not exist yet
  }
}

/** Convert nanosecond OTLP timestamp to ISO string */
function otlpTimestamp(timeUnixNano?: string | number): string {
  if (!timeUnixNano) return new Date().toISOString();
  // OTLP timestamps are nanoseconds; convert to milliseconds
  const ns = typeof timeUnixNano === "string" ? Number(timeUnixNano) : timeUnixNano;
  const ms = Math.floor(ns / 1_000_000);
  return new Date(ms).toISOString();
}

/** Extract string value from OTLP AnyValue */
function anyValueToString(value: Record<string, unknown> | undefined): string {
  if (!value) return "";
  if ("stringValue" in value) return value.stringValue as string;
  if ("intValue" in value) return String(value.intValue);
  if ("doubleValue" in value) return String(value.doubleValue);
  if ("boolValue" in value) return String(value.boolValue);
  return JSON.stringify(value);
}

/** Extract a flat key-value map from OTLP KeyValue[] attributes */
function extractAttributes(
  attrs?: Array<{ key: string; value?: Record<string, unknown> }>
): Record<string, unknown> | undefined {
  if (!attrs || attrs.length === 0) return undefined;
  const result: Record<string, unknown> = {};
  for (const attr of attrs) {
    result[attr.key] = attr.value ? anyValueToString(attr.value) : "";
  }
  return result;
}

/** Find a session resource URI from OTLP resource attributes */
function extractSessionResource(
  resourceAttrs?: Array<{ key: string; value?: Record<string, unknown> }>
): string | undefined {
  if (!resourceAttrs) return undefined;
  const match = resourceAttrs.find(
    (a) => a.key === "ahp.session" || a.key === "session.resource" || a.key === "session.uri"
  );
  return match?.value ? anyValueToString(match.value) : undefined;
}

/**
 * Handle an inbound `otlp/exportLogs` notification.
 * Parses the OTLP/JSON payload and appends NDJSON records to the log file.
 */
export async function handleOtlpLogs(notification: OtlpNotification): Promise<void> {
  if (notification.method !== "otlp/exportLogs") return;

  const { payload } = notification.params;
  const resourceLogs = payload.resourceLogs as Array<{
    resource?: { attributes?: Array<{ key: string; value?: Record<string, unknown> }> };
    scopeLogs?: Array<{
      scope?: { name?: string };
      logRecords?: Array<{
        timeUnixNano?: string | number;
        severityNumber?: number;
        severityText?: string;
        body?: Record<string, unknown>;
        attributes?: Array<{ key: string; value?: Record<string, unknown> }>;
      }>;
    }>;
  }>;

  if (!resourceLogs?.length) return;

  const lines: string[] = [];

  for (const rl of resourceLogs) {
    const session = extractSessionResource(rl.resource?.attributes);

    for (const sl of rl.scopeLogs ?? []) {
      const scope = sl.scope?.name;

      for (const lr of sl.logRecords ?? []) {
        const entry: TelemetryLogEntry = {
          ts: otlpTimestamp(lr.timeUnixNano),
          level: lr.severityText ?? SEVERITY_MAP[lr.severityNumber ?? 0] ?? "INFO",
          body: lr.body ? anyValueToString(lr.body) : "",
        };

        if (session) entry.session = session;
        if (scope) entry.scope = scope;

        const attrs = extractAttributes(lr.attributes);
        if (attrs) entry.attrs = attrs;

        lines.push(JSON.stringify(entry));
      }
    }
  }

  if (lines.length === 0) return;

  await ensureDir();
  await appendFile(LOGS_FILE, lines.join("\n") + "\n");
}
