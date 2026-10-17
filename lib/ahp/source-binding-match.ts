export interface EvidenceSourceBinding {
  sourceRevision?: unknown;
  planVersion?: unknown;
  contentRevision?: unknown;
  manifestRevision?: unknown;
  evidenceDigest?: unknown;
}

function revision(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function optionalRevision(value: unknown): boolean {
  return value === undefined || value === null || revision(value);
}

function consistentManifest(binding: EvidenceSourceBinding): boolean {
  return binding.contentRevision == null || binding.manifestRevision == null
    || binding.contentRevision === binding.manifestRevision;
}

/** Catalog fences and captured digests have distinct roles; both must remain
 * paired. Equal local digests cannot rebind evidence across an invalidated fence. */
export function sourceBindingsMatch(
  summary: EvidenceSourceBinding | null | undefined,
  enrichment: EvidenceSourceBinding | null | undefined,
): boolean {
  return Boolean(summary && enrichment
    && revision(summary.sourceRevision) && revision(summary.planVersion)
    && summary.sourceRevision === enrichment.sourceRevision
    && summary.planVersion === enrichment.planVersion
    && optionalRevision(summary.contentRevision) && optionalRevision(enrichment.contentRevision)
    && optionalRevision(summary.manifestRevision) && optionalRevision(enrichment.manifestRevision)
    && optionalRevision(summary.evidenceDigest) && optionalRevision(enrichment.evidenceDigest)
    && consistentManifest(summary) && consistentManifest(enrichment)
    && (summary.manifestRevision ?? summary.contentRevision ?? null) ===
      (enrichment.manifestRevision ?? enrichment.contentRevision ?? null)
    && (summary.evidenceDigest ?? null) === (enrichment.evidenceDigest ?? null));
}

export function sourceEvidenceRevision(binding: EvidenceSourceBinding | null | undefined): string | undefined {
  if (!revision(binding?.sourceRevision)) return undefined;
  return revision(binding.evidenceDigest) ? binding.evidenceDigest : binding.sourceRevision;
}
