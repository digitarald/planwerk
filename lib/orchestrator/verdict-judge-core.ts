import { judgeVerdictSchema } from "./response-schemas.ts";

export interface JudgeVerdict {
  status: "passed" | "failed" | "needs-human";
  summary: string;
  findings: string[];
}

export interface ReviewVerdict extends JudgeVerdict {
  madeEdits: boolean;
}

export type VerdictJudgeTransport = (
  reviewResponse: string
) => Promise<unknown>;

function needsHuman(summary: string): JudgeVerdict {
  return {
    status: "needs-human",
    summary,
    findings: [],
  };
}

export async function judgeWithTransport(
  reviewResponse: string | undefined,
  transport: VerdictJudgeTransport
): Promise<JudgeVerdict> {
  if (!reviewResponse?.trim()) {
    return needsHuman("Reviewer response is missing; human review required.");
  }

  try {
    const response = await transport(reviewResponse);
    if (!response) {
      return needsHuman("Verdict judge returned no response; human review required.");
    }
    const parsed = judgeVerdictSchema.safeParse(response);
    if (!parsed.success) {
      return needsHuman("Verdict judge returned an invalid result; human review required.");
    }
    return { ...parsed.data, findings: parsed.data.findings.slice(0, 10) };
  } catch {
    return needsHuman("Verdict judge unavailable; human review required.");
  }
}
