import "server-only";

import type { Turn } from "@microsoft/agent-host-protocol";
import { parseVerdictToken, parseFindings, classifyProse } from "./verdict-parse";

/**
 * Verdict from a review skill execution.
 */
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

/**
 * Extract a structured verdict from the agent's turn output after a review.
 *
 * Strategy:
 * 1. Detect whether the agent made file edits (tool calls to edit/create/write).
 * 2. If the reviewer emitted an explicit `VERDICT:` token (the prompt contract),
 *    that is authoritative — map it directly to a status.
 * 3. Otherwise fall back to prose heuristics: edits → failed (agent applied fixes),
 *    positive language → passed, negative language / findings → failed, else
 *    ambiguous → needs-human.
 */
export function extractVerdict(turns: Turn[]): ReviewVerdict {
  // Walk the most recent turns to find the review response. Turns carry
  // `responseParts` in stream order: markdown text and tool calls (whose name
  // lives at `part.toolCall.toolName`).
  const recentTurns = turns.slice(-5);

  let madeEdits = false;
  let responseText = "";

  for (const turn of recentTurns) {
    for (const part of turn.responseParts ?? []) {
      if (part.kind === "toolCall") {
        const toolName = part.toolCall.toolName;
        if (toolName && EDIT_TOOL_PATTERNS.some((p) => p.test(toolName))) {
          madeEdits = true;
        }
      } else if (part.kind === "markdown") {
        responseText += part.content + "\n";
      }
    }
  }

  const findings = parseFindings(responseText);

  // 2. Explicit verdict token is authoritative (overrides the madeEdits heuristic).
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

  // 3a. No token: if the agent made edits, it found and fixed issues.
  // Don't auto-pass here — let processReviewResult decide based on risk policy.
  if (madeEdits) {
    return {
      status: "failed",
      summary: "Review found issues and agent applied fixes.",
      findings: findings.slice(0, 10),
      madeEdits: true,
    };
  }

  // 3b. No token, no edits: classify from prose heuristics.
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

  // Truly ambiguous — escalate
  return {
    status: "needs-human",
    summary: "Review completed but verdict is ambiguous — human review recommended.",
    findings: [],
    madeEdits: false,
  };
}
