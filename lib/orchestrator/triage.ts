import "server-only";

import { type Phase } from "@/lib/types";
import { assessRisk } from "./risk-assessor";
import {
  getAuthoritativeCardRisk,
  persistAuthoritativeRisk,
  type StoredRisk,
} from "./risk-store";
import type { RiskFactsSnapshot } from "./risk-facts";
import { reassessAndPersistRisk } from "./risk-reassessment";
import { getGatesForTransition, getNextPhase, type GateConfig } from "./gate-engine";

export interface TriageResult {
  cardId: string;
  risk: StoredRisk;
  applicableGates: GateConfig[];
  requiredGates: GateConfig[];
  requiresHumanApproval: boolean;
}

const TRIAGE_PHASES: Phase[] = ["plan", "build"];

/**
 * Triage a card entering a new phase.
 * Runs LLM risk assessment, persists the result, and returns applicable gates.
 * Only runs for plan and build phases — other transitions skip triage.
 */
export async function triageCard(
  cardId: string,
  riskSnapshot: RiskFactsSnapshot,
  toPhase: Phase,
  options: { isCurrent?: () => boolean } = {},
): Promise<TriageResult | null> {
  if (!TRIAGE_PHASES.includes(toPhase)) {
    return null;
  }

  await reassessAndPersistRisk(
    cardId,
    riskSnapshot,
    assessRisk,
    (...args) => options.isCurrent?.() === false ? false : persistAuthoritativeRisk(...args),
  );
  const authoritative = getAuthoritativeCardRisk(cardId, riskSnapshot.hostUrl);
  if (authoritative.status !== "current") {
    throw new Error("Risk assessment did not remain current after triage");
  }
  const storedRisk: StoredRisk = authoritative.assessment;

  const nextPhase = getNextPhase(toPhase);
  const applicableGates = nextPhase
    ? getGatesForTransition(toPhase, nextPhase, undefined, storedRisk.level)
    : [];
  const requiredGates = applicableGates.filter((gate) => gate.required);
  const requiresHumanApproval = requiredGates.some(
    (gate) => gate.gateType === "human-approval"
  );

  return {
    cardId,
    risk: storedRisk,
    applicableGates,
    requiredGates,
    requiresHumanApproval,
  };
}
