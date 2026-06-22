import "server-only";

/**
 * Verdict from a review skill execution.
 */
export interface ReviewVerdict {
  status: "passed" | "failed" | "needs-human";
  summary: string;
  findings: string[];
  madeEdits: boolean;
}

/**
 * A turn from AHP's fetchTurns response.
 * Real shape uses `responseParts[]` with `kind: "markdown" | "toolCall"`.
 */
interface ResponsePart {
  kind: string;
  content?: string;
  name?: string; // for toolCall parts
}

interface TurnData {
  id: string;
  message?: { text: string; origin?: { kind: string } };
  responseParts?: ResponsePart[];
  // Legacy shape (fallback)
  response?: { parts?: Array<{ type: string; content?: string }> };
  toolCalls?: Array<{ name: string; result?: { content?: unknown[] } }>;
}

const PASS_SIGNALS = [
  /no\s+(issues?|problems?|concerns?)\s+(found|detected|identified)/i,
  /lgtm/i,
  /looks?\s+good/i,
  /all\s+(checks?\s+)?pass/i,
  /no\s+(critical|significant)\s+(issues?|findings?)/i,
  /code\s+(is\s+)?(clean|solid|well[- ]structured)/i,
  /approved/i,
];

const FAIL_SIGNALS = [
  /\b(bug|vulnerability|security\s+issue)\b/i,
  /\bmust\s+(be\s+)?(fixed|addressed|resolved)\b/i,
  /\bblocking\b/i,
  /\bfail(ed|ing|s)?\b/i,
  /\breject(ed)?\b/i,
  // "critical" and "error" only match when NOT preceded by "no"
  /(?<!no\s+)(critical|error)\s+(issue|problem|finding)/i,
];

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
 * 1. Check if agent made file edits (tool calls to edit/create/write)
 * 2. Parse the last response text for pass/fail signals
 * 3. If edits were made → passed (agent fixed issues)
 * 4. If positive language, no edits → passed clean
 * 5. If negative language → failed
 * 6. Ambiguous → needs-human
 */
export function extractVerdict(turns: unknown[]): ReviewVerdict {
  const typedTurns = turns as TurnData[];

  // Walk turns from newest to oldest to find the review response
  const recentTurns = typedTurns.slice(-5);

  let madeEdits = false;
  let responseText = "";
  const findings: string[] = [];

  for (const turn of recentTurns) {
    // Check responseParts for tool calls (real AHP shape)
    if (turn.responseParts) {
      for (const part of turn.responseParts) {
        if (part.kind === "toolCall" && part.name) {
          if (EDIT_TOOL_PATTERNS.some((p) => p.test(part.name!))) {
            madeEdits = true;
          }
        }
        if (part.kind === "markdown" && part.content) {
          responseText += part.content + "\n";
        }
      }
    }

    // Fallback: legacy shape (turn.toolCalls + turn.response.parts)
    if (!turn.responseParts) {
      if (turn.toolCalls) {
        for (const call of turn.toolCalls) {
          if (EDIT_TOOL_PATTERNS.some((p) => p.test(call.name))) {
            madeEdits = true;
          }
        }
      }
      if (turn.response?.parts) {
        for (const part of turn.response.parts) {
          if (part.type === "markdown" && part.content) {
            responseText += part.content + "\n";
          }
        }
      }
    }
  }

  // Extract findings from bullet points or numbered items
  const bulletPattern = /^[\s]*[-*•]\s+(.+)$/gm;
  const numberedPattern = /^[\s]*\d+[.)]\s+(.+)$/gm;
  let match;
  while ((match = bulletPattern.exec(responseText)) !== null) {
    const line = match[1].trim();
    if (line.length > 10 && line.length < 500) {
      findings.push(line);
    }
  }
  while ((match = numberedPattern.exec(responseText)) !== null) {
    const line = match[1].trim();
    if (line.length > 10 && line.length < 500 && !findings.includes(line)) {
      findings.push(line);
    }
  }

  // If agent made edits, it found and fixed issues.
  // Don't auto-pass here — let processReviewResult decide based on risk policy.
  // Return "failed" with madeEdits=true so the caller can apply shouldFollowEdits logic.
  if (madeEdits) {
    return {
      status: "failed",
      summary: "Review found issues and agent applied fixes.",
      findings: findings.slice(0, 10),
      madeEdits: true,
    };
  }

  // Check for explicit pass signals
  const hasPassSignal = PASS_SIGNALS.some((p) => p.test(responseText));
  const hasFailSignal = FAIL_SIGNALS.some((p) => p.test(responseText));

  if (hasPassSignal && !hasFailSignal) {
    return {
      status: "passed",
      summary: "Review passed — no issues found.",
      findings: [],
      madeEdits: false,
    };
  }

  if (hasFailSignal && !hasPassSignal) {
    return {
      status: "failed",
      summary: "Review found issues that need attention.",
      findings: findings.slice(0, 10),
      madeEdits: false,
    };
  }

  // Mixed signals or unclear — report findings if any
  if (findings.length > 0) {
    return {
      status: "failed",
      summary: `Review produced ${findings.length} finding(s) without clear resolution.`,
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
