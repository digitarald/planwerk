import { SUPPORTED_PROTOCOL_VERSIONS } from "@microsoft/agent-host-protocol";

/**
 * Protocol versions this client offers to an AHP host during `initialize`,
 * highest-first (the host picks the newest version both sides understand).
 *
 * Sourced directly from the installed SDK's canonical list rather than
 * hand-maintained, so it can never drift from what the client code actually
 * implements. The AHP versioning spec requires hosts to only send action
 * types known to the negotiated version
 * (https://microsoft.github.io/agent-host-protocol/specification/versioning),
 * and pre-1.0 negotiation requires an exact minor-version match — offering a
 * stale/lower version here would silently negotiate down and cause the host
 * to withhold newer actions our code depends on (e.g. the 0.5.1
 * `session/inputNeededSet` / `session/inputNeededRemoved` actions behind
 * `SessionState.inputNeeded`).
 */
export const OFFERED_PROTOCOL_VERSIONS: string[] = [...SUPPORTED_PROTOCOL_VERSIONS];


