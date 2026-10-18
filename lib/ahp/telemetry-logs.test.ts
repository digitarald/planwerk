import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { AhpTransport } from "@microsoft/agent-host-protocol/client";

const directory = mkdtempSync(join(tmpdir(), "pw-telemetry-"));
const previous = { data: process.env.PLANWERK_DATA_DIR, run: process.env.PLANWERK_RUN_ID };
process.env.PLANWERK_DATA_DIR = directory;
process.env.PLANWERK_RUN_ID = "telemetry-launch";
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") return { shortCircuit: true, url: "data:text/javascript,export {}" };
    if (specifier === "../data-directory") return nextResolve("../data-directory.ts", context);
    return nextResolve(specifier, context);
  },
});
const { handleOtlpLogs } = await import("./telemetry-logs.ts");
const { TelemetryTapTransport } = await import("./telemetry-transport.ts");
after(() => {
  hooks.deregister();
  if (previous.data === undefined) delete process.env.PLANWERK_DATA_DIR;
  else process.env.PLANWERK_DATA_DIR = previous.data;
  if (previous.run === undefined) delete process.env.PLANWERK_RUN_ID;
  else process.env.PLANWERK_RUN_ID = previous.run;
  rmSync(directory, { recursive: true, force: true });
});

test("host telemetry keeps source time, session and scope with launch correlation and redaction", () => {
  handleOtlpLogs({
    method: "otlp/exportLogs",
    params: {
      channel: "telemetry",
      payload: {
        resourceLogs: [{
          resource: { attributes: [{ key: "ahp.session", value: { stringValue: "session-one" } }] },
          scopeLogs: [{
            scope: { name: "host:test" },
            logRecords: [{
              timeUnixNano: "1792281600000000000", severityNumber: 5,
              body: { stringValue: "Bearer private" },
              attributes: [{ key: "authorization", value: { stringValue: "secret" } }],
            }],
          }],
        }],
      },
    },
  });
  const record = JSON.parse(readFileSync(join(directory, "telemetry/logs.ndjson"), "utf8"));
  assert.equal(record.ts, "2026-10-18T00:00:00.000Z");
  assert.equal(record.runId, "telemetry-launch");
  assert.equal(record.session, "session-one");
  assert.equal(record.scope, "host:test");
  assert.equal(record.level, "DEBUG");
  assert.equal(record.body, "Bearer [REDACTED]");
  assert.equal(record.attrs.authorization, "[REDACTED]");
});

test("malformed telemetry reports a warning without blocking the original transport frame", async (t) => {
  const warnings: unknown[][] = [];
  t.mock.method(console, "warn", (...args: unknown[]) => warnings.push(args));
  const frame = { kind: "text" as const, text: '{"method":"otlp/exportLogs","params":{"payload":{"resourceLogs":{}}}}' };
  const inner: AhpTransport = {
    send() {}, close() {},
    async recv() { return frame; },
  };
  const transport = new TelemetryTapTransport(inner, handleOtlpLogs);
  assert.equal(await transport.recv(), frame);
  assert.equal(warnings.length, 1);
  const failing = new TelemetryTapTransport(inner, () => { throw new Error("invalid host payload"); });
  assert.equal(await failing.recv(), frame);
  assert.equal(warnings.length, 2);
  assert.match(String(warnings[0]), /Could not inspect host telemetry/);
});
