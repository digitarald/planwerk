import type { SessionState, SessionSummary } from "@microsoft/agent-host-protocol";

type SessionSummary07 = SessionSummary & {
  workingDirectories?: unknown;
};

type ChatSummary07 = {
  resource?: unknown;
  workingDirectories?: unknown;
  primaryWorkingDirectory?: unknown;
};

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const directories = value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
  return directories.length > 0 ? directories : undefined;
}

/**
 * Preserve every directory the host advertises. A singular directory is the
 * pre-0.7 wire shape and remains a one-element set for cached and older hosts.
 */
export function sessionWorkingDirectories(summary: SessionSummary): string[] | undefined {
  return stringArray((summary as SessionSummary07).workingDirectories)
    ?? (typeof summary.workingDirectory === "string" ? [summary.workingDirectory] : undefined);
}

/**
 * A multi-directory session is only safe for cwd-sensitive automation when the
 * default chat nominates an explicit primary directory. Older single-directory
 * hosts retain their only directory as the established operational cwd.
 */
export function primaryWorkingDirectory(state: SessionState): string | undefined {
  const chats = state.chats as readonly ChatSummary07[];
  const defaultChat = chats.find((chat) => chat.resource === state.defaultChat);
  const primary = defaultChat?.primaryWorkingDirectory;
  if (typeof primary === "string" && primary.length > 0) return primary;

  const sessionDirectories = stringArray((state as SessionState & { workingDirectories?: unknown }).workingDirectories);
  if (sessionDirectories?.length === 1) return sessionDirectories[0];
  return typeof state.workingDirectory === "string" ? state.workingDirectory : undefined;
}
