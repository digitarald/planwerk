import assert from "node:assert/strict";
import test from "node:test";

import { primaryWorkingDirectory, sessionWorkingDirectories } from "./working-directories.ts";

test("preserves plural AHP 0.7 session directories", () => {
  const summary = {
    workingDirectories: ["file:///repo-a", "file:///repo-b"],
  };
  assert.deepEqual(sessionWorkingDirectories(summary as never), ["file:///repo-a", "file:///repo-b"]);
});

test("maps a legacy singular directory to a one-element set", () => {
  assert.deepEqual(
    sessionWorkingDirectories({ workingDirectory: "file:///repo" } as never),
    ["file:///repo"],
  );
});

test("uses only the default chat primary directory for multi-directory sessions", () => {
  const state = {
    defaultChat: "ahp-chat://default",
    chats: [
      {
        resource: "ahp-chat://default",
        workingDirectories: ["file:///repo-a", "file:///repo-b"],
        primaryWorkingDirectory: "file:///repo-b",
      },
    ],
    workingDirectories: ["file:///repo-a", "file:///repo-b"],
  };
  assert.equal(primaryWorkingDirectory(state as never), "file:///repo-b");
});

test("fails closed when a multi-directory default chat has no primary", () => {
  const state = {
    defaultChat: "ahp-chat://default",
    chats: [{ resource: "ahp-chat://default", workingDirectories: ["file:///repo-a", "file:///repo-b"] }],
    workingDirectories: ["file:///repo-a", "file:///repo-b"],
  };
  assert.equal(primaryWorkingDirectory(state as never), undefined);
});
