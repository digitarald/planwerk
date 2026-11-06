import { z } from "zod";

export const decisionFamilies = ["risk", "answer", "review", "goal", "coherence", "inbox"] as const;
export type DecisionFamily = typeof decisionFamilies[number];
export type DecisionQuestion =
  | { type: "noul"; instructions: string; criteria?: { true?: string; false?: string } }
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "score"; instructions: string; criteria: string[] };
export type DecisionQuestions = Record<string, DecisionQuestion>;

const probability = z.number().finite().min(0).max(1);
export const answerSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("noul"), noul: probability }),
  z.object({
    type: z.literal("choice"), choice: z.string(),
    probabilities: z.record(z.string(), probability), confidence: probability.optional(),
  }),
  z.object({
    type: z.literal("score"), score: z.number().finite().min(0),
    probabilities: z.record(z.string(), probability), confidence: probability.optional(),
  }),
]);
export const responseSchema = z.object({
  model: z.string().trim().min(1),
  answers: z.record(z.string(), answerSchema),
  usage: z.object({ input_tokens: z.number().int().nonnegative(), output_tokens: z.number().int().nonnegative() }),
});
export type DecisionResponse = z.infer<typeof responseSchema>;
export type DecisionAnswer = z.infer<typeof answerSchema>;

export const acceptanceSchema = z.strictObject({
  minimumProbability: probability,
  minimumMargin: probability,
  minimumConfidence: probability.optional(),
  validationId: z.string().trim().min(1),
});
export type DecisionAcceptance = z.infer<typeof acceptanceSchema>;

export interface DecisionOutcome {
  kind: "accepted" | "needs-human" | "deferred";
  key: string;
  policyKey: string;
  reason?: string;
  response?: DecisionResponse;
  latencyMs: number;
  retryAt?: number;
  attempts?: number;
}

const text = z.string().trim().min(1);
const questionSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("noul"), instructions: text,
    criteria: z.strictObject({ true: text.optional(), false: text.optional() }).optional(),
  }),
  z.strictObject({ type: z.literal("choice"), instructions: text, criteria: z.record(text, text) }),
  z.strictObject({ type: z.literal("score"), instructions: text, criteria: z.array(text).min(2).max(10) }),
]);

export function validateQuestions(questions: DecisionQuestions): void {
  const parsed = z.record(text, questionSchema).parse(questions);
  const count = Object.keys(parsed).length;
  if (count < 1 || count > 32) throw new Error("Decision requests require 1 to 32 named questions.");
  for (const question of Object.values(parsed)) {
    if (question.type === "choice" && (Object.keys(question.criteria).length < 2 || Object.keys(question.criteria).length > 255)) {
      throw new Error("Decision choices require 2 to 255 labels.");
    }
    if (question.type === "score" && new Set(question.criteria).size !== question.criteria.length) {
      throw new Error("Decision score levels must be distinct.");
    }
  }
}

export function validateResponse(input: unknown, questions: DecisionQuestions): DecisionResponse {
  const response = responseSchema.parse(input);
  if (JSON.stringify(Object.keys(response.answers).sort()) !== JSON.stringify(Object.keys(questions).sort())) {
    throw new Error("Decision response has missing or extra answers.");
  }
  for (const [name, question] of Object.entries(questions)) {
    const answer = response.answers[name];
    if (answer.type !== question.type) throw new Error("Decision answer type does not match its question.");
    if (answer.type === "noul" || question.type === "noul") continue;
    const labels = question.type === "choice" ? Object.keys(question.criteria) : question.criteria.map((_, index) => String(index));
    const distribution = answer.probabilities;
    if (JSON.stringify(Object.keys(distribution).sort()) !== JSON.stringify(labels.sort()) ||
        Math.abs(Object.values(distribution).reduce((sum, value) => sum + value, 0) - 1) > 0.02) {
      throw new Error("Decision response has an invalid probability distribution.");
    }
    if (answer.type === "choice" && !Object.hasOwn(distribution, answer.choice)) {
      throw new Error("Decision response selected an unknown label.");
    }
    if (answer.type === "score" && question.type === "score" && answer.score > question.criteria.length - 1) {
      throw new Error("Decision score is outside its scale.");
    }
  }
  return response;
}

export function acceptanceReason(response: DecisionResponse, policy?: DecisionAcceptance): string | undefined {
  if (!policy) return "No validated acceptance profile is configured for this decision.";
  for (const [name, answer] of Object.entries(response.answers)) {
    if (answer.type === "choice" && ["unknown", "insufficient", "needs-human"].includes(answer.choice)) {
      return `${name}: the model requires human inspection.`;
    }
    const values = answer.type === "noul" ? [answer.noul, 1 - answer.noul]
      : Object.values(answer.probabilities).sort((a, b) => b - a);
    const selected = answer.type === "choice" ? answer.probabilities[answer.choice] : Math.max(...values);
    const runnerUp = answer.type === "choice"
      ? Math.max(...Object.entries(answer.probabilities).filter(([label]) => label !== answer.choice).map(([, value]) => value))
      : [...values].sort((a, b) => b - a)[1];
    if (selected < policy.minimumProbability || selected - runnerUp < policy.minimumMargin) {
      return `${name}: probability or separation is below the validated acceptance threshold.`;
    }
    if (policy.minimumConfidence !== undefined && answer.type !== "noul" &&
        (answer.confidence === undefined || answer.confidence < policy.minimumConfidence)) {
      return `${name}: provider confidence is missing or below the validated threshold.`;
    }
  }
}

export function decisionChoice<T extends string>(
  outcome: DecisionOutcome, name: string, values: readonly T[],
): T {
  const answer = outcome.response?.answers[name];
  if (outcome.kind !== "accepted" || answer?.type !== "choice") {
    throw new Error(outcome.reason ?? "A current accepted choice is required.");
  }
  const value = values.find((value) => value === answer.choice);
  if (value === undefined) throw new Error("The accepted decision is outside the caller's allowed choices.");
  return value;
}
