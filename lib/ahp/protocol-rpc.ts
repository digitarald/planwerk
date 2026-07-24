import { AhpErrorCodes } from "@microsoft/agent-host-protocol";
import { RpcError } from "@microsoft/agent-host-protocol/client";

import { ProtocolCompatibilityError } from "./protocol.ts";

export function readProtocolCompatibilityError(error: unknown): ProtocolCompatibilityError | undefined {
  if (error instanceof ProtocolCompatibilityError) return error;
  if (!(error instanceof RpcError) || error.code !== AhpErrorCodes.UnsupportedProtocolVersion) {
    return undefined;
  }

  const data = error.data as { supportedVersions?: unknown } | undefined;
  const rawVersions = data?.supportedVersions;
  const supportedVersions = Array.isArray(rawVersions)
    ? rawVersions.filter((version): version is string => typeof version === "string")
    : [];
  return new ProtocolCompatibilityError({
    failure: "no-overlap",
    hostSupportedVersions: supportedVersions,
    relation: Array.isArray(rawVersions) && rawVersions.every((version) => typeof version === "string")
      ? undefined
      : "unknown",
  });
}
