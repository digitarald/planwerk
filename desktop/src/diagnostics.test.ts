import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DiagnosticLog } from "../../lib/diagnostics/log.ts";
import { captureOutput, createDesktopDiagnostics } from "./diagnostics.ts";

test("native console records are persisted and hooks are removable", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "pw-native-logs-"));
  const original = console.info;
  const diagnostics = createDesktopDiagnostics(directory, "launch-test");
  t.after(() => { diagnostics.dispose(); rmSync(directory, { recursive: true, force: true }); });
  console.info("[desktop:test] ready");
  const record = JSON.parse(readFileSync(join(directory, "desktop.log"), "utf8").trim());
  assert.equal(record.runId, "launch-test");
  assert.equal(record.scope, "desktop");
  assert.match(record.body, /ready/);
  diagnostics.dispose();
  assert.equal(console.info, original);
});

test("backend output preserves split UTF-8 and unterminated lines", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "pw-output-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "server.log");
  const log = new DiagnosticLog(path, { runId: "same-launch" }, ["private-token"]);
  const output = captureOutput(log, "ERROR", 456);
  const bytes = Buffer.from("ready \u{1f600}\nBearer private-token\nlast line");
  output.write(bytes.subarray(0, 8));
  output.write(bytes.subarray(8));
  output.end();
  const records = readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(records.map((record) => record.body), ["ready \u{1f600}", "Bearer [REDACTED]", "last line"]);
  assert.ok(records.every((record) => record.runId === "same-launch" && record.childPid === 456));
});

test("oversized output is truncated once and drops continuation until the next line", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "pw-output-large-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "server.log");
  const log = new DiagnosticLog(path);
  const output = captureOutput(log, "INFO", 1);
  output.write(Buffer.from("x".repeat(20_000)));
  output.write(Buffer.from("private continuation\nnext line\n"));
  output.end();
  const records = readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(records.length, 2);
  assert.equal(records[0].truncated, true);
  assert.equal(records[1].body, "next line");
  assert.doesNotMatch(readFileSync(path, "utf8"), /private continuation/);
});
