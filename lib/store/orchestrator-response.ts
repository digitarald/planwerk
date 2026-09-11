export function orchestratorHttpErrorMessage(
  status: number,
  payload: unknown
): string {
  const data = payload && typeof payload === "object"
    ? payload as { error?: unknown; retryable?: unknown }
    : {};
  const detail = typeof data.error === "string" && data.error.trim()
    ? data.error.trim()
    : `CTO request failed with HTTP ${status}`;
  return data.retryable === true
    ? `${detail}. Please retry shortly.`
    : `${detail}. Please try again.`;
}
