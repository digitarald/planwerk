import { z } from "zod";

const nonEmptyText = z.string().trim().min(1);

export const riskAssessmentSchema = z.strictObject({
  level: z.enum(["low", "medium", "high"]),
  factors: z.array(nonEmptyText).min(1),
});

export const judgeVerdictSchema = z.strictObject({
  status: z.enum(["passed", "failed", "needs-human"]),
  summary: nonEmptyText,
  findings: z.array(nonEmptyText),
}).superRefine((verdict, context) => {
  if (verdict.status === "passed" && verdict.findings.length > 0) {
    context.addIssue({ code: "custom", message: "Passed verdicts cannot contain blockers." });
  }
  if (verdict.status === "failed" && verdict.findings.length === 0) {
    context.addIssue({ code: "custom", message: "Failed verdicts must identify a blocker." });
  }
});

export const coherenceVerdictSchema = z.strictObject({
  status: z.enum(["coherent", "conflict", "needs-human"]),
  summary: nonEmptyText,
  findings: z.array(nonEmptyText),
}).superRefine((verdict, context) => {
  if (verdict.status === "coherent" && verdict.findings.length > 0) {
    context.addIssue({ code: "custom", message: "Coherent verdicts cannot contain conflicts." });
  }
  if (verdict.status === "conflict" && verdict.findings.length === 0) {
    context.addIssue({ code: "custom", message: "Conflicts must identify a concrete clash." });
  }
});
