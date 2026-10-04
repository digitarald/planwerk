import type { SessionSummary } from "@microsoft/agent-host-protocol";

import type { AHPSessionSummary } from "./types.ts";
import { projectSessionDirectories } from "./working-directories.ts";

export function mapSdkSessionSummary(summary: SessionSummary): AHPSessionSummary {
  const directories = projectSessionDirectories(summary);
  return {
    resource: summary.resource,
    chats: summary.chats?.map((chat) => ({ ...chat })),
    defaultChat: summary.defaultChat,
    provider: summary.provider,
    title: summary.title,
    status: summary.status,
    createdAt: new Date(summary.createdAt).toISOString(),
    modifiedAt: new Date(summary.modifiedAt).toISOString(),
    activity: summary.activity,
    project: summary.project
      ? { name: summary.project.displayName, path: summary.project.uri }
      : undefined,
    workingDirectories: directories?.workingDirectories,
    workingDirectory: directories?.workingDirectory,
    changes: summary.changes
      ? {
          additions: summary.changes.additions ?? 0,
          deletions: summary.changes.deletions ?? 0,
          files: summary.changes.files ?? 0,
        }
      : undefined,
  };
}

export function applySdkSessionSummaryChanges(
  existing: AHPSessionSummary,
  changes: Partial<SessionSummary>,
): void {
  if (changes.chats !== undefined) existing.chats = changes.chats.map((chat) => ({ ...chat }));
  if (Object.hasOwn(changes, "defaultChat")) existing.defaultChat = changes.defaultChat;
  if (changes.title !== undefined) existing.title = changes.title;
  if (changes.status !== undefined) existing.status = changes.status;
  if (changes.activity !== undefined) existing.activity = changes.activity;
  if (changes.modifiedAt !== undefined) {
    existing.modifiedAt = new Date(changes.modifiedAt).toISOString();
  }

  const directories = projectSessionDirectories(changes);
  if (directories) {
    existing.workingDirectories = directories.workingDirectories;
    existing.workingDirectory = directories.workingDirectory;
  }

  if (changes.project !== undefined) {
    existing.project = changes.project
      ? { name: changes.project.displayName, path: changes.project.uri }
      : undefined;
  }
  if (changes.changes !== undefined) {
    existing.changes = {
      additions: changes.changes.additions ?? 0,
      deletions: changes.changes.deletions ?? 0,
      files: changes.changes.files ?? 0,
    };
  }
}
