export const LOCAL_DESKTOP_HOST = "vscode-local://desktop";

export function isSupportedAhpEndpoint(value: string): boolean {
  if (value === LOCAL_DESKTOP_HOST) return true;
  try {
    const protocol = new URL(value).protocol;
    return protocol === "ws:" || protocol === "wss:";
  } catch {
    return false;
  }
}
