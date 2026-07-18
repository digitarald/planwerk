import { SUPPORTED_PROTOCOL_VERSIONS } from "@microsoft/agent-host-protocol";

// VS Code 1.105 ships an AHP 0.6.0 host before the TypeScript SDK's npm
// package has published its matching release. Planwerk only consumes the
// session-summary and input APIs, which are unchanged in 0.6.0; offering it
// restores interoperability without claiming support for its new UI actions.
const VS_CODE_AHP_COMPATIBILITY_VERSIONS = ["0.6.0"];

export function buildOfferedProtocolVersions(
  supportedVersions: readonly string[] = SUPPORTED_PROTOCOL_VERSIONS,
): string[] {
  return [...new Set([...VS_CODE_AHP_COMPATIBILITY_VERSIONS, ...supportedVersions])];
}

/**
 * Protocol versions this client offers to an AHP host during `initialize`,
 * highest-first (the host picks the newest version both sides understand).
 *
 * Includes the installed SDK's canonical list, plus the temporary 0.6.0
 * compatibility offer required by the current VS Code host. The AHP
 * versioning spec requires hosts to only send action types known to the
 * negotiated version
 * (https://microsoft.github.io/agent-host-protocol/specification/versioning),
 * and pre-1.0 negotiation requires an exact minor-version match.
 */
export const OFFERED_PROTOCOL_VERSIONS = buildOfferedProtocolVersions();
