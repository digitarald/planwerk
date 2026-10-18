import "server-only";

import path from "path";
import { dataDirectory } from "../data-directory";
import { DiagnosticLog } from "../diagnostics/log.ts";

import type { OtlpNotification } from "./telemetry-transport";

const TELEMETRY_DIR = path.join(dataDirectory(), "telemetry");
const LOGS_FILE = path.join(TELEMETRY_DIR, "logs.ndjson");
const log = new DiagnosticLog(
  LOGS_FILE,
  { runId: process.env.PLANWERK_RUN_ID ?? "web", pid: process.pid },
  [process.env.PLANWERK_DESKTOP_TOKEN ?? ""],
  undefined,
  (message) => console.error("[ahp:telemetry]", message),
);

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

/** Convert nanosecond OTLP timestamp to ISO string */
function otlpTimestamp(timeUnixNano?: string | number): string {
  if (!timeUnixNano) return new Date().toISOString();
  // OTLP timestamps are nanoseconds; convert to milliseconds
  const ns = typeof timeUnixNano === "string" ? Number(timeUnixNano) : timeUnixNano;
  const ms = Math.floor(ns / 1_000_000);
  const date = new Date(ms);
  if (!Number.isFinite(date.getTime())) throw new Error("Invalid OTLP log timestamp");
  return date.toISOString();
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
 * Persists OTLP/JSON records with bounded retention and host timestamps.
 */
export function handleOtlpLogs(notification: OtlpNotification): void {
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

  if (!Array.isArray(resourceLogs)) throw new Error("Invalid OTLP resourceLogs");
  if (!resourceLogs.length) return;

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

        log.write({ ...entry, scope: entry.scope ?? "ahp:host" });
      }
    }
  }
}
