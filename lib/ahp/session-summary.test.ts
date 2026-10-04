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

test("preserves lightweight chat metadata, authoritative order, and unknown status", () => {
  const chats = [
    { resource: "ahp-chat:/b", title: "Reviewer", interactivity: "read-only", changes: { files: 2 } },
    { resource: "ahp-chat:/a", title: "Lead", status: 33 },
  ] as NonNullable<SessionSummary["chats"]>;
  const mapped = mapSdkSessionSummary({ ...summary, chats, defaultChat: chats[1].resource });
  assert.deepEqual(mapped.chats, chats);
  assert.equal(mapped.chats?.[0].status, undefined);
  assert.equal(mapped.defaultChat, "ahp-chat:/a");
  applySdkSessionSummaryChanges(mapped, { title: "Renamed" });
  assert.deepEqual(mapped.chats, chats);
  applySdkSessionSummaryChanges(mapped, { chats: [...chats].reverse(), defaultChat: undefined });
  assert.deepEqual(mapped.chats?.map((chat) => chat.resource), ["ahp-chat:/a", "ahp-chat:/b"]);
  assert.equal(mapped.defaultChat, undefined);
  applySdkSessionSummaryChanges(mapped, { chats: [] });
  assert.deepEqual(mapped.chats, []);
});
