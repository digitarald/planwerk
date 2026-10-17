export interface InboxStatus {
  unread: number;
  open: number;
  connected: boolean;
  running: number;
}

export type DesktopState =
  | { kind: "starting" }
  | { kind: "ready"; status: InboxStatus }
  | { kind: "unavailable"; message: string };

export function parseStatus(value: unknown): InboxStatus {
  if (!value || typeof value !== "object"
    || !("unread" in value) || !Number.isSafeInteger(value.unread) || Number(value.unread) < 0
    || !("open" in value) || !Number.isSafeInteger(value.open) || Number(value.open) < Number(value.unread)
    || !("running" in value) || !Number.isSafeInteger(value.running) || Number(value.running) < 0
    || !("connected" in value) || typeof value.connected !== "boolean") {
    throw new Error("Invalid inbox status from the local server");
  }
  return { unread: Number(value.unread), open: Number(value.open), connected: value.connected, running: Number(value.running) };
}

export function menuPresentation(state: DesktopState) {
  if (state.kind === "starting") {
    return { icon: "starting", title: "◌", summary: "Starting Planwerk...", detail: "Preparing the local server", activity: null };
  }
  if (state.kind === "unavailable") {
    return { icon: "offline", title: "!", summary: "Inbox unavailable", detail: state.message, activity: null };
  }
  if (!state.status.connected) {
    return { icon: "offline", title: "!", summary: "Agent host disconnected", detail: "Open Planwerk to connect or retry", activity: null };
  }
  const { unread, open, running } = state.status;
  const count = unread === 0 ? "" : unread > 99 ? "99+" : String(unread);
  return {
    icon: running > 0 ? "working" : unread > 0 ? "unread" : "idle",
    title: [running > 0 ? "◔" : "", count].filter(Boolean).join(" "),
    summary: unread === 0 ? "No unread inbox items" : `${unread} unread inbox item${unread === 1 ? "" : "s"}`,
    detail: `${open} unresolved across all workspaces`,
    activity: running > 0 ? `${running} session${running === 1 ? "" : "s"} running` : "No sessions running",
  };
}

export function externalUrl(value: string, origin: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }

  if (url.origin === origin || url.username || url.password) return null;
  return ["https:", "http:", "mailto:", "vscode:", "vscode-insiders:"].includes(url.protocol)
    ? url.href : null;
}

export function navigationUrl(detail: unknown): string | null {
  // WKWebView's will-navigate payload is JSON text; new-window-open is decoded.
  if (typeof detail === "string") {
    if (!detail.trimStart().startsWith("{")) return detail;
    detail = JSON.parse(detail);
  }
  return detail && typeof detail === "object" && "url" in detail && typeof detail.url === "string"
    ? detail.url : null;
}
