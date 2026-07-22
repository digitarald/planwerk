import { test } from "node:test";
import assert from "node:assert/strict";

import {
  isRetryableGateFailure,
  resolveGateWorkingDirectory,
} from "./gate-command.ts";

test("resolveGateWorkingDirectory preserves filesystem paths", () => {
  assert.equal(resolveGateWorkingDirectory("/Users/example/project"), "/Users/example/project");
});

test("resolveGateWorkingDirectory converts file URIs and decodes path segments", () => {
  assert.equal(
    resolveGateWorkingDirectory("file:///Users/example/My%20Project"),
    "/Users/example/My Project"
  );
});

test("resolveGateWorkingDirectory rejects malformed file URIs", () => {
  assert.throws(() => resolveGateWorkingDirectory("file://%"));
});

test("isRetryableGateFailure identifies infrastructure failures", () => {
  assert.equal(
    isRetryableGateFailure("Working directory not found: file:///Users/example/project"),
    true
  );
  assert.equal(
    isRetryableGateFailure("Invalid working directory: file://% (Invalid URL)"),
    true
  );
  assert.equal(
    isRetryableGateFailure("Abandoned: server restarted — re-run this gate"),
    true
  );
});

test("isRetryableGateFailure leaves command failures suppressed", () => {
  assert.equal(isRetryableGateFailure("Tests: 2 failed, 40 passed"), false);
  assert.equal(isRetryableGateFailure(undefined), false);
});
