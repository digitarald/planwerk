/**
 * Compatibility and safety helpers for AHP 0.6 tool input. The installed SDK
 * predates these wire shapes, so keep the structural handling and policy here.
 */

export type ToolConfirmationIntent = "approve" | "deny" | "unknown";

export interface ToolRiskAssessment {
  status: "loading" | "complete";
  reason?: string;
  safety?: number;
}

interface ConfirmationOptionLike {
  id?: unknown;
  kind?: unknown;
}

interface ToolConfirmationLike {
  status?: unknown;
  options?: unknown;
  riskAssessment?: { status?: unknown };
}

export function toolConfirmationIntent(kind: unknown): ToolConfirmationIntent {
  if (kind === "approve") return "approve";
  if (kind === "deny") return "deny";
  return "unknown";
}

export function canApproveToolConfirmation(riskAssessment?: ToolRiskAssessment): boolean {
  return riskAssessment?.status !== "loading";
}

export function normalizeToolRiskAssessment(value: unknown): ToolRiskAssessment | undefined {
  if (!value || typeof value !== "object") return undefined;
  const assessment = value as { status?: unknown; reason?: unknown; safety?: unknown };
  if (assessment.status === "loading") return { status: "loading" };
  if (assessment.status !== "complete") return undefined;

  const reasonValue = assessment.reason;
  const reason = typeof reasonValue === "string"
    ? reasonValue
    : reasonValue && typeof reasonValue === "object" && typeof (reasonValue as { markdown?: unknown }).markdown === "string"
      ? (reasonValue as { markdown: string }).markdown
      : undefined;
  const safety = typeof assessment.safety === "number" && Number.isFinite(assessment.safety)
    ? Math.min(1, Math.max(0, assessment.safety))
    : undefined;
  return { status: "complete", reason, safety };
}

/**
 * Resolve a confirmation decision from the host's current entry, never from a
 * client-provided option label or intent. AHP 0.6 options are authoritative.
 */
export function resolveToolConfirmationDecision(
  toolCall: ToolConfirmationLike,
  approved: boolean,
  optionId: unknown,
):
  | { ok: true; approved: boolean; selectedOptionId?: string }
  | { ok: false; error: string } {
  if (approved && toolCall.riskAssessment?.status === "loading") {
    return { ok: false, error: "Tool safety assessment is still loading; approval is unavailable" };
  }
  const isResultConfirmation = toolCall.status === "pending-result-confirmation";
  if (isResultConfirmation) {
    if (optionId !== undefined) {
      return { ok: false, error: "Result confirmations do not accept an optionId" };
    }
    return { ok: true, approved };
  }

  const options = Array.isArray(toolCall.options) ? toolCall.options as ConfirmationOptionLike[] : [];
  if (options.length === 0) {
    if (optionId !== undefined) {
      return { ok: false, error: "This tool confirmation has no selectable options" };
    }
    return { ok: true, approved };
  }

  if (typeof optionId !== "string" || optionId.length === 0) {
    return { ok: false, error: "optionId is required for this tool confirmation" };
  }
  const option = options.find((candidate) => candidate.id === optionId);
  if (!option) {
    return { ok: false, error: "optionId is not offered by this tool confirmation" };
  }

  const intent = toolConfirmationIntent(option.kind);
  if (intent === "unknown") {
    return { ok: false, error: "optionId has an unsupported confirmation intent" };
  }
  const expectedApproved = intent === "approve";
  if (approved !== expectedApproved) {
    return { ok: false, error: "approved does not match the selected option intent" };
  }
  return { ok: true, approved: expectedApproved, selectedOptionId: optionId };
}

/**
 * Build the deliberately minimal, client-safe view of an AHP 0.6 OAuth block.
 * In particular, no auth challenge, resource URI, scopes, OAuth client, or
 * credentials cross this boundary; VS Code owns the authentication flow.
 */
export function toolAuthenticationHandoff(toolCall: {
  displayName?: unknown;
  toolName?: unknown;
  [key: string]: unknown;
}): { message: string; toolName?: string } {
  const toolName = typeof toolCall.displayName === "string" && toolCall.displayName.trim()
    ? toolCall.displayName
    : typeof toolCall.toolName === "string" && toolCall.toolName.trim()
      ? toolCall.toolName
      : undefined;
  return {
    message: toolName
      ? `Authentication required for ${toolName}. Complete it in VS Code.`
      : "Tool authentication required. Complete it in VS Code.",
    toolName,
  };
}
