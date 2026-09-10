import { fileURLToPath } from "node:url";

const RETRYABLE_FAILURE_PREFIXES = [
  "Abandoned: server restarted",
  "Invalid working directory:",
  "Working directory not found:",
];

export function resolveGateWorkingDirectory(workingDirectory: string): string {
  if (workingDirectory.startsWith("file:")) {
    return fileURLToPath(workingDirectory);
  }
  if (/^[a-z][a-z\d+.-]*:/i.test(workingDirectory) && !/^[a-z]:[\\/]/i.test(workingDirectory)) {
    throw new Error(`Unsupported working directory URI: ${workingDirectory}`);
  }
  return workingDirectory;
}

export function isRetryableGateFailure(output?: string): boolean {
  return RETRYABLE_FAILURE_PREFIXES.some((prefix) => output?.startsWith(prefix));
}
