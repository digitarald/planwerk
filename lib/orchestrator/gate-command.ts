import { fileURLToPath } from "node:url";

const RETRYABLE_FAILURE_PREFIXES = [
  "Abandoned: server restarted",
  "Invalid working directory:",
  "Working directory not found:",
];

export function resolveGateWorkingDirectory(workingDirectory: string): string {
  return workingDirectory.startsWith("file:")
    ? fileURLToPath(workingDirectory)
    : workingDirectory;
}

export function isRetryableGateFailure(output?: string): boolean {
  return RETRYABLE_FAILURE_PREFIXES.some((prefix) => output?.startsWith(prefix));
}
