import { fileURLToPath } from "node:url";
import { isAbsolute, win32 } from "node:path";

import type { SessionSummary } from "@microsoft/agent-host-protocol";

export interface SessionDirectoryProjection {
  workingDirectories: string[];
  workingDirectory?: string;
}

/**
 * Project AHP's URI set into Planwerk's complete directory list and filesystem
 * cwd. `undefined` means a partial summary did not update the field; an empty
 * array explicitly clears it.
 */
export function projectSessionDirectories(
  summary: Pick<SessionSummary, "workingDirectories">,
): SessionDirectoryProjection | undefined {
  if (summary.workingDirectories === undefined) return undefined;
  const workingDirectories = [...summary.workingDirectories];
  const only = workingDirectories.length === 1 ? workingDirectories[0] : undefined;
  let workingDirectory: string | undefined;
  if (only?.startsWith("file:")) {
    try {
      workingDirectory = fileURLToPath(only);
    } catch (error) {
      console.warn(
        `[ahp] Cannot use non-local working directory ${only}:`,
        error instanceof Error ? error.message : error,
      );
    }
  } else if (only && (isAbsolute(only) || win32.isAbsolute(only))) {
    workingDirectory = only;
  }
  return {
    workingDirectories,
    workingDirectory,
  };
}
