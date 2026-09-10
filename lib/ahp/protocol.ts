const EXACT_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

type ParsedProtocolVersion = readonly [major: number, minor: number, patch: number];

export type ProtocolMismatchRelation = "host-older" | "host-newer" | "mixed" | "unknown";
export type ProtocolCompatibilityFailure = "no-overlap" | "selected-unoffered-version";

function parseExactProtocolVersion(version: string): ParsedProtocolVersion | undefined {
  const match = EXACT_SEMVER.exec(version);
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareParsedVersions(a: ParsedProtocolVersion, b: ParsedProtocolVersion): number {
  return (a[0] - b[0]) || (a[1] - b[1]) || (a[2] - b[2]);
}

function compareExactProtocolVersions(a: string, b: string): number {
  const parsedA = parseExactProtocolVersion(a);
  const parsedB = parseExactProtocolVersion(b);
  if (!parsedA || !parsedB) {
    throw new Error(`Invalid exact AHP protocol version: ${!parsedA ? a : b}`);
  }
  return compareParsedVersions(parsedA, parsedB);
}

export function classifyProtocolMismatch(
  hostSupportedVersions: readonly string[],
  offeredVersions: readonly string[] = OFFERED_PROTOCOL_VERSIONS,
): ProtocolMismatchRelation {
  if (hostSupportedVersions.length === 0 || offeredVersions.length === 0) return "unknown";
  if (hostSupportedVersions.some((version) => offeredVersions.includes(version))) return "unknown";

  const hostVersions = hostSupportedVersions.map(parseExactProtocolVersion);
  const clientVersions = offeredVersions.map(parseExactProtocolVersion);
  if (
    hostVersions.some((version) => version === undefined)
    || clientVersions.some((version) => version === undefined)
  ) {
    return "unknown";
  }

  const exactHostVersions = hostVersions as ParsedProtocolVersion[];
  const exactClientVersions = clientVersions as ParsedProtocolVersion[];
  const oldestClient = exactClientVersions.reduce((oldest, version) =>
    compareParsedVersions(version, oldest) < 0 ? version : oldest
  );
  const newestClient = exactClientVersions.reduce((newest, version) =>
    compareParsedVersions(version, newest) > 0 ? version : newest
  );

  if (exactHostVersions.every((version) => compareParsedVersions(version, oldestClient) < 0)) {
    return "host-older";
  }
  if (exactHostVersions.every((version) => compareParsedVersions(version, newestClient) > 0)) {
    return "host-newer";
  }
  return "mixed";
}

export class ProtocolCompatibilityError extends Error {
  readonly failure: ProtocolCompatibilityFailure;
  readonly hostSupportedVersions: readonly string[];
  readonly offeredVersions: readonly string[];
  readonly relation: ProtocolMismatchRelation;

  constructor(options: {
    failure: ProtocolCompatibilityFailure;
    hostSupportedVersions?: readonly string[];
    offeredVersions?: readonly string[];
    relation?: ProtocolMismatchRelation;
  }) {
    const hostSupportedVersions = options.hostSupportedVersions ?? [];
    const offeredVersions = options.offeredVersions ?? OFFERED_PROTOCOL_VERSIONS;
    const relation = options.relation
      ?? classifyProtocolMismatch(hostSupportedVersions, offeredVersions);
    const message = options.failure === "selected-unoffered-version"
      ? `AHP host selected a protocol version Planwerk did not offer: ${hostSupportedVersions[0] ?? "(missing)"}`
      : "AHP host and Planwerk have no tested protocol version in common";
    super(message);
    this.name = "ProtocolCompatibilityError";
    this.failure = options.failure;
    this.hostSupportedVersions = [...hostSupportedVersions];
    this.offeredVersions = [...offeredVersions];
    this.relation = relation;
  }
}

export function assertNegotiatedProtocolVersion(
  selectedVersion: string,
  offeredVersions: readonly string[] = OFFERED_PROTOCOL_VERSIONS,
): void {
  if (offeredVersions.includes(selectedVersion)) return;
  throw new ProtocolCompatibilityError({
    failure: "selected-unoffered-version",
    hostSupportedVersions: selectedVersion ? [selectedVersion] : [],
    offeredVersions,
  });
}

/**
 * Production speaks only the SDK version Planwerk is built and tested against.
 * Development can make one explicit forward-compatibility retry through
 * {@link forwardRetryProtocolVersions}.
 */
export const BASE_PROTOCOL_VERSION = PROTOCOL_VERSION;
export const OFFERED_PROTOCOL_VERSIONS = Object.freeze([BASE_PROTOCOL_VERSION]);

export function forwardRetryProtocolVersions(
  error: ProtocolCompatibilityError,
  allowForwardCompatibility: boolean,
): string[] | undefined {
  if (
    !allowForwardCompatibility
    || error.failure !== "no-overlap"
    || error.relation !== "host-newer"
  ) {
    return undefined;
  }

  const versions = [...new Set(error.hostSupportedVersions)];
  if (
    versions.length === 0
    || versions.some((version) => {
      const parsed = parseExactProtocolVersion(version);
      return !parsed || compareExactProtocolVersions(version, BASE_PROTOCOL_VERSION) <= 0;
    })
  ) {
    return undefined;
  }

  return versions
    .sort((a, b) => compareExactProtocolVersions(b, a))
    .concat(BASE_PROTOCOL_VERSION);
}
import { PROTOCOL_VERSION } from "@microsoft/agent-host-protocol";
