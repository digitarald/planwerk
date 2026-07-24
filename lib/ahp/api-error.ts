import "server-only";

import { NextResponse } from "next/server";
import { RpcError } from "@microsoft/agent-host-protocol/client";
import { AhpErrorCodes } from "@microsoft/agent-host-protocol";

import { readProtocolCompatibilityError } from "./protocol-rpc";

/**
 * HTTP status overrides for AHP error codes that map cleanly onto standard
 * REST semantics. Everything else — including generic/transport failures —
 * keeps the existing blanket 502 (upstream/host failure), so this is
 * additive and doesn't change behavior for errors it doesn't recognize.
 */
const STATUS_BY_AHP_CODE: Partial<Record<number, number>> = {
  [AhpErrorCodes.PermissionDenied]: 403,
  [AhpErrorCodes.SessionNotFound]: 404,
  [AhpErrorCodes.NotFound]: 404,
  [AhpErrorCodes.Conflict]: 409,
};

/**
 * Build a `NextResponse` for a caught AHP error, using the SDK's structured
 * {@link RpcError} (`.code`/`.data`) when available instead of flattening
 * every failure into an opaque `{ error: string }` 502. Callers on the
 * client can react to `code`/`data` (e.g. show a distinct message for
 * `UnsupportedProtocolVersion`'s `supportedVersions`) instead of parsing
 * `error` text.
 */
export function ahpErrorResponse(err: unknown, fallbackMessage: string): NextResponse {
  const message = err instanceof Error ? err.message : fallbackMessage;
  const compatibilityError = readProtocolCompatibilityError(err);

  if (compatibilityError) {
    return NextResponse.json({
      error: message,
      code: AhpErrorCodes.UnsupportedProtocolVersion,
      data: {
        supportedVersions: compatibilityError.hostSupportedVersions,
        offeredVersions: compatibilityError.offeredVersions,
        relation: compatibilityError.relation,
        failure: compatibilityError.failure,
      },
    }, { status: 502 });
  }

  if (err instanceof RpcError) {
    const status = STATUS_BY_AHP_CODE[err.code] ?? 502;
    return NextResponse.json({ error: message, code: err.code, data: err.data }, { status });
  }

  return NextResponse.json({ error: message }, { status: 502 });
}
