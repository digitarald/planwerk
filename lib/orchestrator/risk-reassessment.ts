import type { RiskLevel } from "../types.ts";
import type {
  RiskAssessment,
} from "./risk-assessor.ts";
import type { RiskFactsSnapshot } from "./risk-facts.ts";
import { requiresConservativeHighRisk } from "./risk-classifier.ts";
export { parseAuthoritativeRiskInput } from "./risk-facts.ts";

export async function reassessAndPersistRisk(
  cardId: string,
  snapshot: RiskFactsSnapshot,
  assess: (input: RiskFactsSnapshot["input"]) => Promise<RiskAssessment>,
  persist: (
    snapshot: RiskFactsSnapshot,
    level: RiskLevel,
    factors: string[],
    assessedBy: "copilot",
  ) => boolean,
): Promise<RiskAssessment> {
  if (snapshot.cardId !== cardId) {
    throw new Error("Risk facts snapshot is for a different card");
  }
  const conservative = requiresConservativeHighRisk(snapshot.input);
  const assessment = conservative ?? await assess(snapshot.input);
  try {
    if (!persist(snapshot, assessment.level, assessment.factors, "copilot")) {
      throw new Error("authoritative facts changed during assessment");
    }
  } catch (error) {
    throw new Error(
      `Failed to persist risk assessment: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }
  return assessment;
}
