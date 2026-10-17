import type Database from "better-sqlite3";
import { isSessionOwnedByHost } from "../db/session-ownership.ts";
import {
  sourceBindingsMatch,
  sourceEvidenceRevision,
  type EvidenceSourceBinding,
} from "../ahp/source-binding-match.ts";

import type { Phase } from "../types.ts";
import {
  isPlanChangesetRef,
  normalizeChangesetRef,
  sourceChangesetRef,
} from "../types.ts";

type SourceBinding = EvidenceSourceBinding;

interface CachedSummary {
  resource?: unknown;
  _planwerkRiskFacts?: SourceBinding;
}

interface CachedEnrichment {
  changesetVerified?: unknown;
  totalFileCount?: unknown;
  additions?: unknown;
  deletions?: unknown;
  planContentHash?: unknown;
  _planwerkSource?: SourceBinding;
}

type GateRevisionResult =
  | {
      ok: true;
      changesetRef: string;
      sourceRevision: string;
      hostUrl: string;
    }
  | {
      ok: false;
      reason: string;
    };

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function validCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

export function resolveAuthoritativeGateRevision(
  db: Database.Database,
  cardId: string,
  phase: Phase,
  expectedHostUrl?: string,
): GateRevisionResult {
  const row = db.prepare(`
    SELECT host_url, summary_json, enrichment_json
    FROM session_cache
    WHERE session_uri = ?
  `).get(cardId) as {
    host_url: string;
    summary_json: string;
    enrichment_json: string | null;
  } | undefined;

  if (!row?.enrichment_json) {
    return { ok: false, reason: "current AHP enrichment is unavailable" };
  }
  if (
    !nonEmptyString(row.host_url)
    || (expectedHostUrl !== undefined && row.host_url !== expectedHostUrl)
    || !isSessionOwnedByHost(db, cardId, row.host_url)
  ) {
    return { ok: false, reason: "current AHP host binding is unavailable or mismatched" };
  }

  let summary: CachedSummary;
  let enrichment: CachedEnrichment;
  try {
    summary = JSON.parse(row.summary_json) as CachedSummary;
    enrichment = JSON.parse(row.enrichment_json) as CachedEnrichment;
  } catch {
    return { ok: false, reason: "current AHP facts are invalid" };
  }

  if (summary.resource !== cardId) {
    return { ok: false, reason: "current AHP facts do not identify this card" };
  }

  const summarySource = summary._planwerkRiskFacts;
  const enrichmentSource = enrichment._planwerkSource;
  const sourceRevision = sourceEvidenceRevision(summarySource);
  if (!sourceBindingsMatch(summarySource, enrichmentSource) || !sourceRevision) {
    return {
      ok: false,
      reason: "current AHP summary and enrichment revisions are not bound",
    };
  }

  let changesetRef: string;
  if (phase === "plan") {
    if (
      !nonEmptyString(enrichment.planContentHash)
      || !isPlanChangesetRef(enrichment.planContentHash)
    ) {
      return { ok: false, reason: "current plan revision is unavailable" };
    }
    changesetRef = normalizeChangesetRef(enrichment.planContentHash);
  } else {
    if (
      enrichment.changesetVerified !== true ||
      !validCount(enrichment.totalFileCount) ||
      !validCount(enrichment.additions) ||
      !validCount(enrichment.deletions)
    ) {
      return {
        ok: false,
        reason: "current session changeset revision is unverified",
      };
    }
    changesetRef = sourceChangesetRef(sourceRevision);
  }

  if (!changesetRef) {
    return { ok: false, reason: "current changeset revision is unavailable" };
  }

  return {
    ok: true,
    changesetRef,
    sourceRevision,
    hostUrl: row.host_url,
  };
}
