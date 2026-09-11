import type Database from "better-sqlite3";

import type { RiskLevel } from "../types.ts";
import {
  currentRiskFactsSnapshot,
  getRiskFactsSnapshot,
} from "./risk-facts.ts";
import { requiresConservativeHighRisk } from "./risk-classifier.ts";

export interface StoredRisk {
  cardId: string;
  level: RiskLevel;
  factors: string[];
  assessedAt: string;
  assessedBy: "copilot" | "human";
  riskDigest: string | null;
}

interface RiskRow {
  card_id: string;
  risk_level: string;
  risk_factors: string;
  assessed_at: string;
  assessed_by: string;
  risk_digest: string | null;
}

export type AuthoritativeRisk =
  | {
      status: "current";
      assessment: StoredRisk;
      currentDigest: string;
    }
  | {
      status: "missing";
      currentDigest: string | null;
    }
  | {
      status: "unbound" | "facts-unavailable" | "policy-unsafe";
      assessment: StoredRisk;
      currentDigest: string | null;
    }
  | {
      status: "stale";
      assessment: StoredRisk;
      currentDigest: string;
    };

export interface RiskAutomationPolicy {
  current: boolean;
  level: RiskLevel;
  reason?: string;
}

function mapRow(row: RiskRow): StoredRisk {
  return {
    cardId: row.card_id,
    level: row.risk_level as RiskLevel,
    factors: JSON.parse(row.risk_factors),
    assessedAt: row.assessed_at,
    assessedBy: row.assessed_by as "copilot" | "human",
    riskDigest: row.risk_digest,
  };
}

/**
 * The sole policy-facing risk read. A persisted verdict is authoritative only
 * while it remains bound to the current server-owned card facts.
 */
export function readAuthoritativeRisk(
  db: Database.Database,
  cardId: string,
  hostUrl?: string,
): AuthoritativeRisk {
  const row = db
    .prepare("SELECT * FROM card_risk WHERE card_id = ?")
    .get(cardId) as RiskRow | undefined;
  const currentSnapshot = hostUrl
    ? getRiskFactsSnapshot(db, hostUrl, cardId)
    : currentRiskFactsSnapshot(db, cardId);
  const currentDigest = currentSnapshot?.digest ?? null;

  if (!row) return { status: "missing", currentDigest };

  const assessment = mapRow(row);
  if (!assessment.riskDigest) {
    return { status: "unbound", assessment, currentDigest };
  }
  if (!currentDigest) {
    return { status: "facts-unavailable", assessment, currentDigest: null };
  }
  if (assessment.riskDigest !== currentDigest) {
    return { status: "stale", assessment, currentDigest };
  }
  if (
    assessment.level !== "high"
    && currentSnapshot
    && requiresConservativeHighRisk(currentSnapshot.input)
  ) {
    return { status: "policy-unsafe", assessment, currentDigest };
  }
  return { status: "current", assessment, currentDigest };
}

/**
 * Conservative policy projection. Callers that can wait should require
 * `current`; callers that must select gates/reviewers use the returned high
 * fallback so missing or stale facts can never reduce scrutiny.
 */
export function riskAutomationPolicy(
  risk: AuthoritativeRisk,
): RiskAutomationPolicy {
  if (risk.status === "current") {
    return { current: true, level: risk.assessment.level };
  }
  const reason = risk.status === "missing"
    ? "Risk assessment is missing."
    : risk.status === "unbound"
      ? "Risk assessment is legacy or unbound to current facts."
      : risk.status === "facts-unavailable"
        ? "Authoritative risk facts are unavailable."
        : risk.status === "policy-unsafe"
          ? "Risk assessment is below the conservative risk floor for current facts."
        : "Risk assessment is stale because card facts changed.";
  return { current: false, level: "high", reason };
}
