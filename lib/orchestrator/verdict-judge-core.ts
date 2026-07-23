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
) => Promise<string | undefined>;

function needsHuman(summary: string): JudgeVerdict {
  return {
    status: "needs-human",
    summary,
    findings: [],
  };
}

export function parseJudgeResponse(content: string): JudgeVerdict | null {
  try {
    const cleaned = content
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/, "")
      .trim();
    const parsed: unknown = JSON.parse(cleaned);
    if (!parsed || typeof parsed !== "object") return null;

    const candidate = parsed as Record<string, unknown>;
    const status = candidate.status;
    const summary = candidate.summary;
    const findings = candidate.findings;
    if (
      status !== "passed" &&
      status !== "failed" &&
      status !== "needs-human"
    ) {
      return null;
    }
    if (typeof summary !== "string" || summary.trim() === "") return null;
    if (
      !Array.isArray(findings) ||
      !findings.every((finding) => typeof finding === "string" && finding.trim() !== "")
    ) {
      return null;
    }

    const normalizedFindings = findings.map((finding) => finding.trim());
    if (status === "passed" && normalizedFindings.length > 0) return null;
    if (status === "failed" && normalizedFindings.length === 0) return null;

    return {
      status,
      summary: summary.trim(),
      findings: normalizedFindings.slice(0, 10),
    };
  } catch {
    return null;
  }
}

export async function judgeWithTransport(
  reviewResponse: string | undefined,
  transport: VerdictJudgeTransport
): Promise<JudgeVerdict> {
  if (!reviewResponse?.trim()) {
    return needsHuman("Reviewer response is missing; human review required.");
  }

  try {
    const content = await transport(reviewResponse);
    if (!content) {
      return needsHuman("Verdict judge returned no response; human review required.");
    }
    return (
      parseJudgeResponse(content) ??
      needsHuman("Verdict judge returned an invalid result; human review required.")
    );
  } catch {
    return needsHuman("Verdict judge unavailable; human review required.");
  }
}
