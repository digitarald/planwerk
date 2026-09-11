import "server-only";

import { getDb } from "@/lib/db/schema";
import type { RiskLevel } from "@/lib/types";
import type { RiskInput } from "./risk-assessor";
import {
  setCardRiskIfFactsCurrent,
} from "./risk-persistence";
import {
  getRiskFactsSnapshot,
  type RiskFactsSnapshot,
} from "./risk-facts";
import {
  readAuthoritativeRisk,
  riskAutomationPolicy,
  type AuthoritativeRisk,
} from "./risk-authority";
export type { AuthoritativeRisk, StoredRisk } from "./risk-authority";
export { setCardRiskIfFactsCurrent, setCardRiskInDb } from "./risk-persistence";

export function getAuthoritativeCardRisk(
  cardId: string,
  hostUrl?: string,
): AuthoritativeRisk {
  return readAuthoritativeRisk(getDb(), cardId, hostUrl);
}

export function getRiskForAutomation(
  cardId: string,
  hostUrl?: string,
): RiskLevel {
  return riskAutomationPolicy(
    getAuthoritativeCardRisk(cardId, hostUrl),
  ).level;
}

/**
 * Load risk inputs from Planwerk's server-owned session cache rather than the
 * browser-supplied board snapshot used for conversational context.
 */
export function getAuthoritativeRiskInput(
  hostUrl: string,
  cardId: string,
): RiskInput | null {
  return getAuthoritativeRiskSnapshot(hostUrl, cardId)?.input ?? null;
}

export function getAuthoritativeRiskSnapshot(
  hostUrl: string,
  cardId: string,
): RiskFactsSnapshot | null {
  return getRiskFactsSnapshot(getDb(), hostUrl, cardId);
}

export function persistAuthoritativeRisk(
  snapshot: RiskFactsSnapshot,
  level: RiskLevel,
  factors: string[],
  assessedBy: "copilot" = "copilot",
): boolean {
  return setCardRiskIfFactsCurrent(
    getDb(),
    snapshot,
    level,
    factors,
    assessedBy,
  );
}
