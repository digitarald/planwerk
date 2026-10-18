import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DiagnosticLog, LOG_ENTRY_BYTES, redactLogText } from "./log.ts";

test("structured logs preserve correlation and source time while redacting nested secrets", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "pw-logs-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "test.log");
  const log = new DiagnosticLog(path, { runId: "run-one", pid: 123 }, ["private-launch-token"]);
  assert.equal(log.write({
    level: "WARN", scope: "test", ts: "2026-10-18T00:00:00Z",
    body: 'Bearer private-launch-token password="abc" https://user:pass@host/path?token=abc',
    attrs: { authorization: "anything", harmless: 'quote " and slash \\', apiKey: "private" },
  }), true);
  const text = readFileSync(path, "utf8");
  const record = JSON.parse(text);
  assert.equal(record.runId, "run-one");
  assert.equal(record.pid, 123);
  assert.equal(record.ts, "2026-10-18T00:00:00Z");
  assert.ok(record.recordedAt);
  assert.equal(record.attrs.authorization, "[REDACTED]");
  assert.equal(record.attrs.apiKey, "[REDACTED]");
  assert.equal(record.attrs.harmless, 'quote " and slash \\');
  assert.doesNotMatch(text, /private-launch-token|user:pass|abc/);
  assert.equal(statSync(path).mode & 0o777, 0o600);
});

test("rotation remains bounded during a continuous run and retains newest records", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "pw-rotate-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "test.log");
  const log = new DiagnosticLog(path, {}, [], 512);
  for (let index = 0; index < 40; index++) {
    assert.equal(log.write({ level: "INFO", scope: "test", body: `event-${index}`, padding: "x".repeat(100) }), true);
  }
  assert.deepEqual(readdirSync(directory).sort(), ["test.log", "test.log.1", "test.log.2"]);
  for (const name of readdirSync(directory)) {
    assert.ok(statSync(join(directory, name)).size <= 512);
    for (const line of readFileSync(join(directory, name), "utf8").trim().split("\n")) JSON.parse(line);
  }
  assert.match(readFileSync(path, "utf8"), /event-39/);
});

test("oversized Unicode records are bounded and explicitly marked", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "pw-large-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "test.log");
  const log = new DiagnosticLog(path);
  log.write({
    level: "ERROR", scope: "test", body: "\u{1f600}".repeat(30_000),
    ts: "2026-10-18T00:00:00Z", session: "host-session",
  });
  assert.ok(statSync(path).size <= LOG_ENTRY_BYTES);
  const record = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(record.truncated, true);
  assert.equal(record.session, "host-session");
  assert.equal(record.ts, "2026-10-18T00:00:00Z");
});

test("write failures are visible, rate-limited, and logging recovers", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "pw-failure-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const blocker = join(directory, "not-a-directory");
  writeFileSync(blocker, "");
  const failures: string[] = [];
  const log = new DiagnosticLog(join(blocker, "test.log"), {}, [], undefined, (message) => failures.push(message));
  const entry = { level: "INFO", scope: "test", body: "test" };
  assert.equal(log.write(entry), false);
  assert.equal(log.write(entry), false);
  assert.equal(failures.length, 1);
  assert.match(failures[0], /Log write failed/);
  rmSync(blocker);
  assert.equal(log.write(entry), true);
});

test("common credential formats are redacted", () => {
  assert.equal(redactLogText("Bearer hello github_pat_123456 token=abc&api_key=xyz Basic YTpi"),
    "Bearer [REDACTED] [REDACTED] token=[REDACTED]&api_key=[REDACTED] Basic [REDACTED]");
});
