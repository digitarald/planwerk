import {
  extractMarkdownResponseText,
  type ResponsePartLike,
  type TurnWithResponsePartsLike,
} from "../ahp/response-parts.ts";
import { parseVerdictToken, parseFindings, classifyProse } from "./verdict-parse.ts";

export interface ReviewVerdict {
  status: "passed" | "failed" | "needs-human";
  summary: string;
  findings: string[];
  madeEdits: boolean;
}

const EDIT_TOOL_PATTERNS = [
  /^edit$/i,
  /^create$/i,
  /^write_file$/i,
  /^replace$/i,
  /^insert$/i,
  /^delete_file$/i,
];

function isEditingToolCall(part: ResponsePartLike): boolean {
  if (part.kind !== "toolCall" || !("toolCall" in part)) return false;
  const toolCall = part.toolCall;
  if (!toolCall || typeof toolCall !== "object") return false;

  const toolName = (toolCall as { toolName?: unknown }).toolName;
  return typeof toolName === "string" && EDIT_TOOL_PATTERNS.some((p) => p.test(toolName));
}

/**
 * Extract a structured verdict from review turns. Text is deliberately limited
 * to markdown response parts: system notification content and opaque metadata
 * are harness state, never reviewer output.
 */
export function evaluateVerdict(
  turns: readonly TurnWithResponsePartsLike[]
): ReviewVerdict {
  const recentTurns = turns.slice(-5);
  const madeEdits = recentTurns.some((turn) =>
    (turn.responseParts ?? []).some(isEditingToolCall)
  );
  const responseText = extractMarkdownResponseText(recentTurns);
  const findings = parseFindings(responseText);

  const token = parseVerdictToken(responseText);
  if (token === "pass") {
    return {
      status: "passed",
      summary: madeEdits
        ? "Review passed — reviewer verdict: pass (fixes applied)."
        : "Review passed — reviewer verdict: pass.",
      findings: [],
      madeEdits,
    };
  }
  if (token === "fail") {
    return {
      status: "failed",
      summary: madeEdits
        ? "Review found issues and agent applied fixes."
        : "Review found issues that need attention.",
      findings: findings.slice(0, 10),
      madeEdits,
    };
  }
  if (token === "needs-human") {
    return {
      status: "needs-human",
      summary: "Reviewer requested human review.",
      findings: findings.slice(0, 10),
      madeEdits,
    };
  }

  if (madeEdits) {
    return {
      status: "failed",
      summary: "Review found issues and agent applied fixes.",
      findings: findings.slice(0, 10),
      madeEdits: true,
    };
  }

  const prose = classifyProse(responseText, findings);
  if (prose === "passed") {
    return {
      status: "passed",
      summary: "Review passed — no issues found.",
      findings: [],
      madeEdits: false,
    };
  }
  if (prose === "failed") {
    return {
      status: "failed",
      summary: findings.length > 0
        ? `Review produced ${findings.length} finding(s) without clear resolution.`
        : "Review found issues that need attention.",
      findings: findings.slice(0, 10),
      madeEdits: false,
    };
  }

  return {
    status: "needs-human",
    summary: "Review completed but verdict is ambiguous — human review recommended.",
    findings: [],
    madeEdits: false,
  };
}
