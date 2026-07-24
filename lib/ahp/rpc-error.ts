import "server-only";

import { RpcError } from "@microsoft/agent-host-protocol/client";
import { AhpErrorCodes } from "@microsoft/agent-host-protocol";
import type { PermissionDeniedErrorData } from "@microsoft/agent-host-protocol";

import { classifyError, ConnectionError } from "./connection-error";
import { readProtocolCompatibilityError } from "./protocol-rpc";
import type { ProtocolCompatibilityError } from "./protocol";

function formatVersions(versions: readonly string[]): string {
  return versions.length > 0 ? versions.join(", ") : "not provided";
}

function classifyProtocolCompatibilityError(error: ProtocolCompatibilityError): ConnectionError {
  const hostVersions = formatVersions(error.hostSupportedVersions);
  const planwerkVersions = formatVersions(error.offeredVersions);

  if (error.failure === "selected-unoffered-version") {
    return {
      type: "error",
      code: "unsupported_protocol_version",
      message: "The AHP host returned an invalid protocol selection",
      hint: `The host selected ${hostVersions}, but Planwerk offered ${planwerkVersions}. Update or restart the host before retrying.`,
    };
  }

  switch (error.relation) {
    case "host-older":
      return {
        type: "error",
        code: "unsupported_protocol_version",
        message: "This AHP host is older than Planwerk supports",
        hint: `The host offers ${hostVersions}; Planwerk supports ${planwerkVersions}. Update the agent host before retrying.`,
      };
    case "host-newer":
      return {
        type: "error",
        code: "unsupported_protocol_version",
        message: "This AHP host is newer than Planwerk supports",
        hint: `The host offers ${hostVersions}; Planwerk supports ${planwerkVersions}. Update Planwerk or use a supported agent host.`,
      };
    case "mixed":
      return {
        type: "error",
        code: "unsupported_protocol_version",
        message: "This AHP host has no tested protocol version in common with Planwerk",
        hint: `The host offers ${hostVersions}; Planwerk supports ${planwerkVersions}. Update Planwerk or the agent host so the exact versions overlap.`,
      };
    case "unknown":
      return {
        type: "error",
        code: "unsupported_protocol_version",
        message: "This AHP host has no proven protocol overlap with Planwerk",
        hint: `The host advertises ${hostVersions}; Planwerk supports ${planwerkVersions}. Version ranges or malformed values are not retried automatically.`,
      };
  }
}

/**
 * Classifies a caught error into a structured {@link ConnectionError}.
 *
 * Prefers the SDK's structured {@link RpcError} (`.code`/`.data`, per the
 * `AhpErrorCodes` taxonomy) over message-text sniffing wherever the thrown
 * error actually is one — this is the authoritative signal the server sent,
 * not a guess. Falls back to the existing {@link classifyError} heuristic for
 * transport failures, timeouts, and anything else that isn't a structured
 * RPC error.
 *
 * Only codes that change user-facing behavior get a dedicated
 * `ConnectionErrorCode` (a version mismatch or a permission denial call for
 * different UI/copy than a generic failure); everything else falls through
 * to `classifyError`'s existing heuristics so this doesn't balloon into a
 * 1:1 mirror of every `AhpErrorCode`. `AuthRequired` deliberately still maps
 * to the existing generic `auth_failed` classification — implementing the
 * full re-authentication flow is out of scope here.
 */
export function classifyAhpError(
  err: unknown,
  context: "connect" | "protocol" | "stream" | "request",
): ConnectionError {
  const compatibilityError = readProtocolCompatibilityError(err);
  if (compatibilityError) return classifyProtocolCompatibilityError(compatibilityError);

  if (err instanceof RpcError) {
    switch (err.code) {
      case AhpErrorCodes.PermissionDenied: {
        const data = err.data as PermissionDeniedErrorData | undefined;
        return {
          type: "error",
          code: "permission_denied",
          message: "The AHP host denied access to this resource",
          hint: data?.request
            ? "The host may grant access via a resource request — try again from the editor."
            : "This resource is outside what the agent host allows the client to read.",
        };
      }
      case AhpErrorCodes.SessionNotFound:
        return {
          type: "error",
          code: "session_not_found",
          message: "This session no longer exists on the host",
          hint: "It may have been closed or the host restarted. Refresh to see the current session list.",
        };
      case AhpErrorCodes.NotFound:
        return {
          type: "error",
          code: "session_not_found",
          message: "The requested resource was not found",
        };
      case AhpErrorCodes.AuthRequired:
        // Deliberately generic — the full re-authentication flow (obtaining
        // tokens, calling `authenticate`) is out of scope; this only avoids
        // falling through to message-text sniffing for a code we already know.
        return {
          type: "error",
          code: "auth_failed",
          message: "Authentication required by the AHP host",
          hint: "Make sure you're signed in to GitHub Copilot in VS Code, or restart the agent host with --without-connection-token.",
        };
      default:
        break;
    }
  }

  return classifyError(err instanceof Error ? err.message : String(err), context);
}
