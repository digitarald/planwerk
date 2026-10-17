const REASONS: Record<string, string> = {
  changed: "Session evidence changed during collection. Refresh again when the session settles.",
  superseded: "A newer evidence refresh replaced this request.",
  unavailable: "Complete session evidence is unavailable. No current evidence was recorded.",
  unsupported: "This session exceeds the supported evidence collection limits.",
};

export async function requestEvidenceRefresh(
  hostUrl: string,
  sessionUri: string,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  const response = await fetcher("/api/ahp/sessions/evidence", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ hostUrl, sessionUri }),
    signal,
  });
  const raw: unknown = await response.json();
  if (!raw || typeof raw !== "object") throw new Error("The evidence refresh returned an invalid response");
  const data = raw as { success?: unknown; reason?: unknown; error?: unknown; session?: { resource?: unknown } };
  if (response.ok && data.success === true && data.session?.resource === sessionUri) return;
  const reason = typeof data.reason === "string" ? REASONS[data.reason] : undefined;
  throw new Error(
    typeof data.error === "string" ? data.error : reason ?? `Evidence refresh failed (${response.status})`,
  );
}
