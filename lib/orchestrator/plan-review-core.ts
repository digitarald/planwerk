export type PlanReviewStatus = "passed" | "failed" | "needs-human";

export interface PlanReviewVerdict {
  status: PlanReviewStatus;
  summary: string;
  findings: string[];
}

export function parsePlanReviewVerdict(content: string | undefined): PlanReviewVerdict | null {
  if (!content?.trim()) return null;

  try {
    const cleaned = content
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();
    const parsed = JSON.parse(cleaned) as Record<string, unknown>;
    if (
      !["passed", "failed", "needs-human"].includes(String(parsed.status)) ||
      typeof parsed.summary !== "string" ||
      !Array.isArray(parsed.findings) ||
      !parsed.findings.every((finding) => typeof finding === "string")
    ) {
      return null;
    }

    const status = parsed.status as PlanReviewStatus;
    const findings = parsed.findings
      .map((finding) => finding.trim())
      .filter(Boolean);
    if ((status === "failed") !== (findings.length > 0)) return null;

    return {
      status,
      summary: parsed.summary.trim(),
      findings,
    };
  } catch {
    return null;
  }
}

export function formatPlanReviewFeedback(verdict: PlanReviewVerdict): string {
  const findings = verdict.findings.map((finding) => `- ${finding}`).join("\n");
  return [
    "An independent rubber-duck review found issues to address before approval:",
    verdict.summary,
    findings,
    "Revise the plan to resolve these findings, then present it for approval again.",
  ].filter(Boolean).join("\n\n");
}
