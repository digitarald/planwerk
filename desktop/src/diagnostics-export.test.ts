import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { EXPORT_TAIL_BYTES, exportDiagnostics } from "./diagnostics-export.ts";

test("offline export includes only bounded allowlisted logs and safe metadata", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "pw-export-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(join(directory, "server.log"), "Bearer private\n" + "old\n".repeat(EXPORT_TAIL_BYTES) + "newest\n");
  writeFileSync(join(directory, "desktop.log.1"), "token=private\n");
  writeFileSync(join(directory, "planwerk.db"), "database-secret");
  mkdirSync(join(directory, "copilot-sdk"));
  writeFileSync(join(directory, "copilot-sdk", "events.jsonl"), "conversation-secret");
  const path = await exportDiagnostics(directory, { runId: "export-run", version: "test", channel: "dev", state: "unavailable" });
  const text = readFileSync(path, "utf8");
  const report = JSON.parse(text);
  assert.equal(report.runId, "export-run");
  assert.equal(report.state, "unavailable");
  assert.equal(report.files["server.log"].truncated, true);
  assert.ok(Buffer.byteLength(report.files["server.log"].content) <= EXPORT_TAIL_BYTES);
  assert.match(report.files["server.log"].content, /newest/);
  assert.equal(report.files["webview.log"].error, "not-created");
  assert.doesNotMatch(text, /database-secret|conversation-secret|token=private/);
  assert.equal(Object.keys(report.files).length, 12);
  assert.equal(statSync(path).mode & 0o777, 0o600);
});

test("export does not follow a log symlink into unrelated files", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "pw-export-link-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const outside = join(directory, "private.txt");
  writeFileSync(outside, "unrelated-secret");
  symlinkSync(outside, join(directory, "server.log"));
  const path = await exportDiagnostics(directory, { runId: "test", version: "test", channel: "dev", state: "starting" });
  const report = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(report.files["server.log"].error, "unreadable");
  assert.doesNotMatch(readFileSync(path, "utf8"), /unrelated-secret/);
});
