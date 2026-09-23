export const LOCAL_DESKTOP_HOST = "vscode-local://desktop";

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function isSupportedAhpEndpoint(value: string): boolean {
  if (value === LOCAL_DESKTOP_HOST) return true;
  try {
    const protocol = new URL(value).protocol;
    return protocol === "ws:" || protocol === "wss:";
  } catch {
    return false;
  }
}

export function migratePersistedAhpEndpoint(value: unknown): string | null {
  if (typeof value !== "string" || !isSupportedAhpEndpoint(value)) return null;
  if (value === LOCAL_DESKTOP_HOST) return value;

  const endpoint = new URL(value);
  if (
    LOOPBACK_HOSTNAMES.has(endpoint.hostname)
    && endpoint.searchParams.has("tkn")
  ) {
    return LOCAL_DESKTOP_HOST;
  }
  return value;
}
