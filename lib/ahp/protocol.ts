/**
 * Protocol versions this client offers to an AHP host during `initialize`,
 * highest-first (the host picks the newest version both sides understand).
 *
 * Planwerk speaks the AHP 0.4+ "chat" model. 0.5.0 ships in current VS Code
 * Insiders but isn't in the SDK yet; its changes don't touch the wire paths we
 * use, so our SDK client interoperates with a 0.5 host.
 */
export const OFFERED_PROTOCOL_VERSIONS: string[] = ["0.5.0", "0.4.0"];


