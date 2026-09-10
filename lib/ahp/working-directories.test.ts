import assert from "node:assert/strict";
import test from "node:test";

import { projectSessionDirectories } from "./working-directories.ts";

test("preserves AHP session directories without choosing among multiple roots", () => {
  const summary = {
    workingDirectories: ["file:///repo-a", "file:///repo-b"],
  };
  assert.deepEqual(projectSessionDirectories(summary), {
    workingDirectories: ["file:///repo-a", "file:///repo-b"],
    workingDirectory: undefined,
  });
});

test("distinguishes an omitted directory update from an explicit clear", () => {
  assert.equal(projectSessionDirectories({}), undefined);
  assert.deepEqual(projectSessionDirectories({ workingDirectories: [] }), {
    workingDirectories: [],
    workingDirectory: undefined,
  });
});

test("uses a singular file directory as the operational directory", () => {
  assert.deepEqual(projectSessionDirectories({ workingDirectories: ["file:///repo-a"] }), {
    workingDirectories: ["file:///repo-a"],
    workingDirectory: "/repo-a",
  });
});

test("preserves a singular non-file operational directory", () => {
  assert.deepEqual(projectSessionDirectories({ workingDirectories: ["/repo-a"] }), {
    workingDirectories: ["/repo-a"],
    workingDirectory: "/repo-a",
  });
});

test("does not treat a remote workspace URI as a local operational directory", () => {
  assert.deepEqual(projectSessionDirectories({
    workingDirectories: ["vscode-remote://ssh-remote+host/repo-a"],
  }), {
    workingDirectories: ["vscode-remote://ssh-remote+host/repo-a"],
    workingDirectory: undefined,
  });
});

test("preserves non-local file URIs without failing session mapping", (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  assert.deepEqual(projectSessionDirectories({
    workingDirectories: ["file://server/share/repo-a"],
  }), {
    workingDirectories: ["file://server/share/repo-a"],
    workingDirectory: undefined,
  });
  assert.equal(warn.mock.callCount(), 1);
});
