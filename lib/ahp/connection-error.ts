export type ConnectionErrorCode =
  | "connection_refused"
  | "auth_failed"
  | "protocol_error"
  | "disconnected"
  | "unsupported_protocol_version"
  | "permission_denied"
  | "session_not_found"
  | "unknown";

export interface ConnectionError {
  type: "error";
  message: string;
  code: ConnectionErrorCode;
  hint?: string;
}

/**
 * Classifies a raw error message into a structured ConnectionError
 * with a user-friendly hint.
 */
export function classifyError(rawMessage: string, context: "connect" | "protocol" | "stream" | "request"): ConnectionError {
  const lower = rawMessage.toLowerCase();

  if (
    lower.includes("forbidden") ||
    lower.includes("403") ||
    lower.includes("unauthorized") ||
    lower.includes("authentication is required") ||
    lower.includes("auth") && lower.includes("required")
  ) {
    return {
      type: "error",
      code: "auth_failed",
      message: "Authentication required by the AHP host",
      hint: "The server requires authentication. Make sure you're signed in to GitHub Copilot in VS Code, or restart the agent host with --without-connection-token.",
    };
  }

  if (lower.includes("no live vs code editor agent host endpoint")) {
    return {
      type: "error",
      code: "connection_refused",
      message: "No live VS Code Agent Host was found",
      hint: "Open desktop VS Code with GitHub Copilot enabled, then retry. Agent Host starts automatically and publishes an ephemeral local endpoint; there is no fixed port or separate setting.",
    };
  }

  if (
    lower.includes("econnrefused") ||
    lower.includes("enotfound") ||
    lower.includes("etimedout") ||
    lower.includes("ehostunreach") ||
    lower.includes("econnreset") ||
    lower.includes("failed to open") ||
    lower.includes("connect failed") ||
    lower.includes("dns")
  ) {
    return {
      type: "error",
      code: "connection_refused",
      message: "Could not reach the AHP host",
      hint: "Retry VS Code (local), or start an isolated host manually with: code agent host --host 127.0.0.1 --port 8082 --without-connection-token",
    };
  }

  if (context === "protocol" || lower.includes("protocol") || lower.includes("initialize")) {
    return {
      type: "error",
      code: "protocol_error",
      message: "Protocol handshake failed",
      hint: "The server is reachable but rejected the AHP protocol handshake. Check that the server version is compatible.",
    };
  }

  if (lower.includes("lost") || lower.includes("closed") || lower.includes("disconnect")) {
    return {
      type: "error",
      code: "disconnected",
      message: rawMessage,
      hint: "The connection was lost. The server may have restarted or the network dropped.",
    };
  }

  // Context-based fallback: connect failures are likely network issues
  if (context === "connect") {
    return {
      type: "error",
      code: "connection_refused",
      message: "Could not reach the AHP host",
      hint: rawMessage,
    };
  }

  return {
    type: "error",
    code: "unknown",
    message: rawMessage,
  };
}
