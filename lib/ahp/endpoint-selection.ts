export interface DesktopSocketProbe {
  socketPath: string;
  modifiedAt: number;
  sessionCount: number;
  protocolVersion: string;
  serverName?: string;
  serverVersion?: string;
}

/** Prefer the richest live catalog, with stable tie-breakers. */
export function selectDesktopSocket(
  probes: readonly DesktopSocketProbe[],
): DesktopSocketProbe | undefined {
  return [...probes].sort((a, b) =>
    b.sessionCount - a.sessionCount
    || b.modifiedAt - a.modifiedAt
    || a.socketPath.localeCompare(b.socketPath)
  )[0];
}

export function aggregateIncompatibleProtocolVersions(
  versionSets: readonly (readonly string[] | undefined)[],
): string[] | undefined {
  const incompatible = versionSets.filter(
    (versions): versions is readonly string[] => versions !== undefined,
  );
  if (incompatible.length === 0) return undefined;
  return [...new Set(incompatible.flat())];
}

export function allDesktopCandidatesProtocolIncompatible(
  versionSets: readonly (readonly string[] | undefined)[],
): boolean {
  return versionSets.length > 0 && versionSets.every((versions) => versions !== undefined);
}
