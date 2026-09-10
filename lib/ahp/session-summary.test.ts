import assert from "node:assert/strict";
import test from "node:test";

import type { SessionSummary } from "@microsoft/agent-host-protocol";

import {
  applySdkSessionSummaryChanges,
  mapSdkSessionSummary,
} from "./session-summary.ts";

const summary = {
  resource: "copilotcli:/session",
  provider: "copilotcli",
  title: "Task",
  status: 1,
  createdAt: "2026-09-09T00:00:00.000Z",
  modifiedAt: "2026-09-09T01:00:00.000Z",
  workingDirectories: ["file:///repo-a", "file:///repo-b"],
} as SessionSummary;

test("maps SDK summaries without choosing among multiple roots", () => {
  const mapped = mapSdkSessionSummary(summary);
  assert.deepEqual(mapped.workingDirectories, ["file:///repo-a", "file:///repo-b"]);
  assert.equal(mapped.workingDirectory, undefined);
});

test("applies directory replacement and explicit clearing", () => {
  const mapped = mapSdkSessionSummary(summary);

  applySdkSessionSummaryChanges(mapped, {
    workingDirectories: ["file:///repo-c"],
  });
  assert.deepEqual(mapped.workingDirectories, ["file:///repo-c"]);
  assert.equal(mapped.workingDirectory, "/repo-c");

  applySdkSessionSummaryChanges(mapped, { workingDirectories: [] });
  assert.deepEqual(mapped.workingDirectories, []);
  assert.equal(mapped.workingDirectory, undefined);
});

test("leaves directories unchanged when a partial update omits them", () => {
  const mapped = mapSdkSessionSummary(summary);
  applySdkSessionSummaryChanges(mapped, { title: "Renamed" });

  assert.equal(mapped.title, "Renamed");
  assert.deepEqual(mapped.workingDirectories, ["file:///repo-a", "file:///repo-b"]);
  assert.equal(mapped.workingDirectory, undefined);
});
