import type { getSessionOwnership } from "../db/session-ownership";

export type OwnershipDiagnostic = NonNullable<ReturnType<typeof getSessionOwnership>>;

function diagnostic(value: unknown, sessionUri: string): OwnershipDiagnostic {
  if (!value || typeof value !== "object") throw new Error("Ownership details are unavailable");
  const item = value as OwnershipDiagnostic;
  if (item.sessionUri !== sessionUri || typeof item.quarantined !== "boolean"
    || !Number.isSafeInteger(item.revision) || !Array.isArray(item.hosts)
    || !item.hosts.length || item.hosts.some((host) =>
      typeof host?.hostId !== "string" || !host.hostId || typeof host.label !== "string")
    || !item.hosts.some((host) => host.hostId === item.owner?.hostId)) {
    throw new Error("The ownership response was invalid. Reload the conflict details.");
  }
  return item;
}

export async function fetchOwnership(
  sessionUri: string, signal: AbortSignal, fetcher: typeof fetch = fetch,
): Promise<OwnershipDiagnostic> {
  const response = await fetcher(`/api/ahp/sessions/ownership?sessionUri=${encodeURIComponent(sessionUri)}`, { signal });
  const data: unknown = await response.json();
  if (!response.ok) throw new Error("Could not load ownership details. Try again.");
  return diagnostic(data, sessionUri);
}

const recoveryErrors: Record<string, string> = {
  stale: "Ownership changed while you were deciding. Reload the choices before confirming.",
  "in-flight": "A session action is still running or unresolved. Resolve it before changing ownership.",
  "not-quarantined": "This conflict has already been resolved. Reopen the card to see current facts.",
  "catalog-missing": "The selected host no longer lists this session. Choose its current host instead.",
  "catalog-unavailable": "The selected host is unavailable. Reconnect it before resolving ownership.",
};

export async function recoverOwnership(
  sessionUri: string, hostId: string, expectedRevision: number,
  signal: AbortSignal, fetcher: typeof fetch = fetch,
): Promise<OwnershipDiagnostic> {
  const response = await fetcher("/api/ahp/sessions/ownership", {
    method: "POST", headers: { "Content-Type": "application/json" }, signal,
    body: JSON.stringify({ sessionUri, hostId, expectedRevision, confirm: true }),
  });
  const data: unknown = await response.json();
  if (!data || typeof data !== "object") throw new Error("Ownership recovery returned an invalid response");
  const result = data as { success?: unknown; ownership?: unknown; reason?: unknown; error?: unknown };
  if (response.ok && result.success === true) return diagnostic(result.ownership, sessionUri);
  throw new Error(
    typeof result.reason === "string" && recoveryErrors[result.reason]
      ? recoveryErrors[result.reason]
      : typeof result.error === "string" ? result.error : "Ownership could not be changed. Reload the conflict details.",
  );
}
