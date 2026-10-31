import { createHash } from "node:crypto";

import type { Artifact, PendingInput, SessionDetails } from "../types";
import type { AHPSessionSummary } from "./types";
import { hashPlanContent, type ChangesetEnrichment } from "./changeset-enricher";
import { sourceBindingsMatch } from "./source-binding-match";
import type { PlanSource } from "./plan-source";

export interface RiskFactsSourceBinding {
  /** Catalog observation/invalidation fence, not a digest of file bytes. */
  sourceRevision: string;
  planVersion: string;
  /** Legacy name for manifestRevision. Never a captured-content digest. */
  contentRevision?: string;
  manifestRevision?: string;
  /** Digest of captured file resources and plan bytes, not continuing freshness. */
  evidenceDigest?: string;
}

export interface BoundChangesetEnrichment extends ChangesetEnrichment {
  _planwerkSource: RiskFactsSourceBinding;
}

export type SourceAwareSummary = AHPSessionSummary & {
  _planwerkAHPSourceRevision?: string;
};

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function attachAHPSourceRevision(
  summary: AHPSessionSummary,
  sdkSummary: { _meta?: Record<string, unknown> },
): void {
  const meta = sdkSummary._meta;
  if (!meta) return;
  const revision = [
    meta.sourceRevision, meta.contentRevision, meta.changesetRevision, meta.revision,
    (meta.changeset as Record<string, unknown> | undefined)?.revision,
    (meta.content as Record<string, unknown> | undefined)?.revision,
  ].find((value): value is string | number =>
    (typeof value === "string" && value.trim().length > 0)
    || (typeof value === "number" && Number.isFinite(value)));
  if (revision !== undefined) {
    (summary as SourceAwareSummary)._planwerkAHPSourceRevision = `ahp:${String(revision)}`;
  } else {
    delete (summary as SourceAwareSummary)._planwerkAHPSourceRevision;
  }
}

export function summarySourceRevision(summary: AHPSessionSummary): string {
  const explicit = (summary as SourceAwareSummary)._planwerkAHPSourceRevision;
  if (explicit) return explicit;
  if (!summary.resource || !summary.modifiedAt) return "";
  return digest({
    resource: summary.resource,
    provider: summary.provider,
    modifiedAt: summary.modifiedAt,
    files: summary.changes?.files ?? 0,
    additions: summary.changes?.additions ?? 0,
    deletions: summary.changes?.deletions ?? 0,
  });
}

export function enrichmentManifestRevision(
  enrichment: ChangesetEnrichment | null | undefined,
): string | undefined {
  if (!enrichment?.changesetVerified) return undefined;
  return digest({
    files: [...enrichment.fileChanges]
      .map((file) => ({
        id: file.id ?? "", path: file.path, added: file.added, removed: file.removed,
      }))
      .sort((a, b) => a.id.localeCompare(b.id) || a.path.localeCompare(b.path)
        || a.added - b.added || a.removed - b.removed),
    totalFileCount: enrichment.totalFileCount,
    additions: enrichment.additions,
    deletions: enrichment.deletions,
    planContentHash: enrichment.planContentHash ?? "",
  });
}

export function enrichmentEvidenceDigest(
  enrichment: ChangesetEnrichment | null | undefined,
): string | undefined {
  if (!enrichment?.changesetVerified || !enrichment.capturedFilesDigest) return undefined;
  return digest({
    files: enrichment.capturedFilesDigest,
    planContent: enrichment.planContent ?? null,
  });
}

export function riskFactsSourceBinding(
  summary: AHPSessionSummary,
  enrichment?: ChangesetEnrichment | null,
): RiskFactsSourceBinding {
  const manifestRevision = enrichmentManifestRevision(enrichment);
  return {
    sourceRevision: summarySourceRevision(summary),
    planVersion: summary.modifiedAt,
    contentRevision: manifestRevision,
    manifestRevision,
    evidenceDigest: enrichmentEvidenceDigest(enrichment),
  };
}

export function cacheableSummary(
  summary: AHPSessionSummary,
  pendingInput: PendingInput | undefined,
  enrichment?: ChangesetEnrichment | null,
) {
  return {
    ...summary,
    lastEvidenceCapture: enrichment?.evidenceCapture ?? summary.lastEvidenceCapture,
    _planwerkRiskFacts: {
      ...riskFactsSourceBinding(summary, enrichment),
      pendingInput: pendingInput ?? null,
    },
  };
}

export function bindEnrichment(
  summary: AHPSessionSummary,
  enrichment: ChangesetEnrichment,
  source: "live" | "explicit" = "live",
): BoundChangesetEnrichment {
  const evidenceCapture = {
    capturedAt: new Date().toISOString(), source,
    coverage: enrichment.capturedFilesDigest ? "bytes" as const
      : enrichment.changesetVerified ? "manifest" as const : "transcript" as const,
  };
  // Retain provenance when a later invalidation deliberately drops all facts.
  summary.lastEvidenceCapture = evidenceCapture;
  return { ...enrichment, evidenceCapture, _planwerkSource: riskFactsSourceBinding(summary, enrichment) };
}

export function enrichmentMatchesSummary(
  summary: AHPSessionSummary,
  enrichment: ChangesetEnrichment | null | undefined,
): enrichment is BoundChangesetEnrichment {
  const source = (enrichment as Partial<BoundChangesetEnrichment> | null | undefined)?._planwerkSource;
  const expected = riskFactsSourceBinding(summary, enrichment);
  return sourceBindingsMatch(source, expected);
}

export function sessionSignature(summary: AHPSessionSummary): string {
  return JSON.stringify({
    status: summary.status, title: summary.title ?? "", activity: summary.activity ?? "",
    sourceRevision: summarySourceRevision(summary),
  });
}

export function mergeFreshEnrichment(
  changesetResult: ChangesetEnrichment | null,
  sessionArtifacts: Artifact[],
  sessionDetails?: SessionDetails,
  sessionPlanSource?: PlanSource,
): ChangesetEnrichment | null {
  if (!changesetResult && sessionArtifacts.length === 0
    && !sessionDetails?.lastAgentMessage && !sessionDetails?.runtimeError) return null;
  const artifacts = [...(changesetResult?.artifacts ?? [])];
  for (const artifact of sessionArtifacts) {
    for (let index = artifacts.length - 1; index >= 0; index--) {
      if (artifacts[index].type === artifact.type) artifacts.splice(index, 1);
    }
    artifacts.push(artifact);
  }
  const plans = artifacts.filter((artifact) => artifact.type === "plan");
  const planContent = plans.length === 1 ? plans[0].contentRef : undefined;
  return {
    ...(changesetResult ?? {
      codeFileCount: 0, totalFileCount: 0, fileChanges: [], additions: 0, deletions: 0,
      changesetVerified: false,
    }),
    artifacts,
    planContent,
    planContentHash: planContent ? hashPlanContent(planContent) : undefined,
    planSource: sessionPlanSource ?? changesetResult?.planSource,
    lastAgentMessage: sessionDetails?.lastAgentMessage,
    outcomeEvidence: sessionDetails?.outcomeEvidence,
    runtimeError: sessionDetails?.runtimeError,
  };
}

export interface SessionEvidenceUpdate {
  session: AHPSessionSummary;
  enrichment: ChangesetEnrichment | null;
  pendingInput?: PendingInput;
}
const globalEvidence = globalThis as typeof globalThis & {
  __planwerkEvidenceCoordination?: {
    reads: Map<string, symbol>;
    listeners: Map<string, Set<(update: SessionEvidenceUpdate) => void>>;
  };
};
const { reads, listeners } = globalEvidence.__planwerkEvidenceCoordination ??= {
  reads: new Map(),
  listeners: new Map(),
};
const key = (hostUrl: string, sessionUri: string) => JSON.stringify([hostUrl, sessionUri]);

export function beginEvidenceRead(hostUrl: string, sessionUri: string): symbol {
  const token = Symbol("evidence-read");
  const uriKey = key(hostUrl, sessionUri);
  reads.set(uriKey, token);
  return token;
}

export function releaseEvidenceRead(hostUrl: string, sessionUri: string, token: symbol): void {
  const uriKey = key(hostUrl, sessionUri);
  if (reads.get(uriKey) === token) reads.delete(uriKey);
}

/** Invalidate without creating a retained generation when no read owns it. */
export function invalidateEvidenceReads(hostUrl: string, sessionUri: string): void {
  const uriKey = key(hostUrl, sessionUri);
  reads.delete(uriKey);
}

export function isEvidenceReadCurrent(hostUrl: string, sessionUri: string, token: symbol): boolean {
  return reads.get(key(hostUrl, sessionUri)) === token;
}

export function observeEvidenceRefresh(hostUrl: string, listener: (update: SessionEvidenceUpdate) => void): () => void {
  let observers = listeners.get(hostUrl);
  if (!observers) listeners.set(hostUrl, observers = new Set());
  observers.add(listener);
  return () => {
    observers.delete(listener);
    if (observers.size === 0) listeners.delete(hostUrl);
  };
}

/** Called only after a successful cache CAS, including explicit invalidation. */
export function publishEvidenceRefresh(hostUrl: string, update: SessionEvidenceUpdate): void {
  for (const listener of listeners.get(hostUrl) ?? []) {
    try {
      listener(update);
    } catch (error) {
      console.error("[ahp:evidence] Refresh observer failed:", error);
    }
  }
}

export interface SessionOwnershipRecoveryUpdate {
  session: AHPSessionSummary;
  selectedHostUrl: string;
  revision: number;
}

const globalOwnershipRecovery = globalThis as typeof globalThis & {
  __planwerkOwnershipRecoveryObservers?: Map<string, Set<(update: SessionOwnershipRecoveryUpdate) => void>>;
};
const ownershipRecoveryObservers = globalOwnershipRecovery.__planwerkOwnershipRecoveryObservers ??= new Map();

export function observeOwnershipRecovery(
  hostUrl: string,
  listener: (update: SessionOwnershipRecoveryUpdate) => void,
): () => void {
  let observers = ownershipRecoveryObservers.get(hostUrl);
  if (!observers) ownershipRecoveryObservers.set(hostUrl, observers = new Set());
  observers.add(listener);
  return () => {
    observers.delete(listener);
    if (observers.size === 0) ownershipRecoveryObservers.delete(hostUrl);
  };
}

/** Commit first, then revoke old reads and notify every affected live bridge. */
export function publishOwnershipRecovery(
  knownHostUrls: string[],
  update: SessionOwnershipRecoveryUpdate,
): void {
  const hosts = new Set(knownHostUrls);
  for (const hostUrl of hosts) {
    invalidateEvidenceReads(hostUrl, update.session.resource);
  }
  for (const hostUrl of hosts) {
    for (const listener of ownershipRecoveryObservers.get(hostUrl) ?? []) {
      try {
        listener(update);
      } catch {
        console.error("[ahp:ownership] Recovery observer failed");
      }
    }
  }
}
