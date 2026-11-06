import { z } from "zod";
import { decisionFamilies, responseSchema } from "./core.ts";

export const evaluationCaseSchema = z.strictObject({
  family: z.enum(decisionFamilies),
  question: z.string().min(1),
  expected: z.string().min(1),
  critical: z.boolean().default(false),
  outcome: z.enum(["accepted", "needs-human", "deferred"]),
  response: responseSchema.optional(),
  latencyMs: z.number().finite().nonnegative(),
  baselineLatencyMs: z.number().finite().nonnegative().optional(),
  baselineCostUsd: z.number().finite().nonnegative().optional(),
});
export type EvaluationCase = z.infer<typeof evaluationCaseSchema>;

function percentile(values: number[], quantile: number): number | null {
  if (!values.length) return null;
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.max(0, Math.ceil(ordered.length * quantile) - 1)];
}

export function evaluateDecisions(cases: EvaluationCase[], inputUsdPerMillion = 0.042) {
  return Object.fromEntries(decisionFamilies.flatMap((family) => {
    const rows = cases.filter((row) => row.family === family);
    if (!rows.length) return [];
    let accepted = 0, correct = 0, criticalErrors = 0, tokens = 0;
    const calibration: Array<{ probability: number; correct: boolean; providerConfidence?: number }> = [];
    for (const row of rows) {
      const answer = row.response?.answers[row.question];
      tokens += row.response?.usage.input_tokens ?? 0;
      if (row.outcome !== "accepted") continue;
      if (!answer || answer.type === "score") throw new Error("Accepted evaluation cases require a named categorical or boolean answer.");
      const predicted = answer.type === "choice" ? answer.choice : String(answer.noul >= 0.5);
      const isCorrect = predicted === row.expected;
      accepted++;
      if (isCorrect) correct++;
      else if (row.critical) criticalErrors++;
      calibration.push({
        probability: answer.type === "choice" ? answer.probabilities[answer.choice] : Math.max(answer.noul, 1 - answer.noul),
        correct: isCorrect,
        ...(answer.type === "choice" && answer.confidence !== undefined ? { providerConfidence: answer.confidence } : {}),
      });
    }
    const baselines = rows.filter((row) => row.baselineLatencyMs !== undefined);
    return [[family, {
      samples: rows.length, accepted, coverage: accepted / rows.length,
      acceptedAccuracy: accepted ? correct / accepted : null,
      incorrectAccepted: accepted - correct, criticalErrors,
      p50Ms: percentile(rows.map((row) => row.latencyMs), 0.5),
      p95Ms: percentile(rows.map((row) => row.latencyMs), 0.95),
      baselineP95Ms: percentile(baselines.map((row) => row.baselineLatencyMs!), 0.95),
      estimatedInferenceCostUsd: tokens * inputUsdPerMillion / 1_000_000,
      baselineCostUsd: rows.some((row) => row.baselineCostUsd !== undefined)
        ? rows.reduce((sum, row) => sum + (row.baselineCostUsd ?? 0), 0) : null,
      calibration,
      safetyGate: accepted > 0 && criticalErrors === 0 ? "requires-human-validation" : "not-ready",
    }]];
  }));
}
