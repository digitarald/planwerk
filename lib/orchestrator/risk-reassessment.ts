import type { RiskLevel } from "../types.ts";
import type {
  RiskAssessment,
} from "./risk-assessor.ts";
import type { RiskFactsSnapshot } from "./risk-facts.ts";
import { requiresConservativeHighRisk } from "./risk-classifier.ts";
import { AssessmentLane } from "./assessment-lane.ts";
export { parseAuthoritativeRiskInput } from "./risk-facts.ts";

const lane = new AssessmentLane<RiskAssessment>();

export async function reassessAndPersistRisk(
  cardId: string,
  snapshot: RiskFactsSnapshot,
  assess: (input: RiskFactsSnapshot["input"], options?: { hostUrl?: string; owner?: string }) => Promise<RiskAssessment>,
  persist: (
    snapshot: RiskFactsSnapshot,
    level: RiskLevel,
    factors: string[],
    assessedBy: "copilot" | "rule" | "decision-model",
    decision?: { key: string; policy: string },
  ) => boolean,
): Promise<RiskAssessment> {
  if (snapshot.cardId !== cardId) {
    throw new Error("Risk facts snapshot is for a different card");
  }
  const conservative = requiresConservativeHighRisk(snapshot.input);
  // Share only model work. Each caller retains its own admission context and
  // must independently authorize/CAS the result after its await.
  const assessment: RiskAssessment = conservative ? { ...conservative, assessedBy: "rule" } : await lane.run(
    JSON.stringify([snapshot.hostUrl, cardId]), snapshot.digest,
    () => assess(snapshot.input, { hostUrl: snapshot.hostUrl, owner: cardId }),
  );
  try {
    if (!persist(snapshot, assessment.level, assessment.factors, assessment.assessedBy ?? "copilot",
      assessment.decisionKey && assessment.decisionPolicy
        ? { key: assessment.decisionKey, policy: assessment.decisionPolicy } : undefined)) {
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
