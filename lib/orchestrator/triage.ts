import "server-only";

import { type Phase } from "@/lib/types";
import { assessRisk, type RiskInput } from "./risk-assessor";
import { getCardRisk, setCardRisk, type StoredRisk } from "./risk-store";
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
  riskInput: RiskInput,
  toPhase: Phase
): Promise<TriageResult | null> {
  if (!TRIAGE_PHASES.includes(toPhase)) {
    return null;
  }

  const { level, factors } = await assessRisk(riskInput);

  setCardRisk(cardId, level, factors, "copilot");

  const storedRisk =
    getCardRisk(cardId) ??
    ({
      cardId,
      level,
      factors,
      assessedAt: new Date().toISOString(),
      assessedBy: "copilot",
    } satisfies StoredRisk);

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
