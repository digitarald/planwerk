export type ReviewRisk = "low" | "medium" | "high";

export function resolveReviewPrompt(
  defaultPrompt: string,
  promptsByRisk: Partial<Record<ReviewRisk, string>> | undefined,
  riskLevel: ReviewRisk
): string {
  return promptsByRisk?.[riskLevel] ?? defaultPrompt;
}
