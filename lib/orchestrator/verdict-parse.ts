/**
 * Pure, dependency-free verdict parsing for review skills.
 *
 * Kept free of the `@/` alias and `server-only` so it can be exercised directly by
 * the `node --test` harness (mirrors the `coherence-detect.ts` precedent). The
 * `server-only` boundary and AHP `Turn` plumbing live in `verdict-extractor.ts`,
 * which delegates the text classification here.
 *
 * Precedence: a machine-readable `VERDICT:` token (the review-prompt contract) is
 * authoritative. Only when no token is present do we fall back to the historical
 * prose heuristics — a best-effort safety net, no longer the primary decision.
 */

export type VerdictToken = "pass" | "fail" | "needs-human";
export type ProseStatus = "passed" | "failed" | "needs-human";

export const PASS_SIGNALS = [
  /no\s+(issues?|problems?|concerns?)\s+(found|detected|identified)/i,
  /lgtm/i,
  /looks?\s+good/i,
  /all\s+(checks?\s+)?pass/i,
  /no\s+(critical|significant)\s+(issues?|findings?)/i,
  /code\s+(is\s+)?(clean|solid|well[- ]structured)/i,
  /approved/i,
];

export const FAIL_SIGNALS = [
  /\b(bug|vulnerability|security\s+issue)\b/i,
  /\bmust\s+(be\s+)?(fixed|addressed|resolved)\b/i,
  /\bblocking\b/i,
  /\bfail(ed|ing|s)?\b/i,
  /\breject(ed)?\b/i,
  // "critical" and "error" only match when NOT preceded by "no"
  /(?<!no\s+)(critical|error)\s+(issue|problem|finding)/i,
];

// Matches the review-prompt contract line, e.g. "VERDICT: pass", "**Verdict:**
// needs-human", "verdict = FAILED". Global so we can take the LAST occurrence,
// since the contract asks the reviewer to end its reply with the verdict.
const VERDICT_TOKEN = /\bverdict\b\s*[:=-]?\s*\*{0,2}\s*(pass(?:ed)?|fail(?:ed)?|needs[\s-]?human|human)/gi;

/**
 * Extract the explicit verdict token from the reviewer's text, if present.
 * Returns the LAST match (the concluding verdict), or `null` when absent.
 */
export function parseVerdictToken(text: string): VerdictToken | null {
  let match: RegExpExecArray | null;
  let last: string | null = null;
  VERDICT_TOKEN.lastIndex = 0;
  while ((match = VERDICT_TOKEN.exec(text)) !== null) {
    last = match[1].toLowerCase();
  }
  if (last === null) return null;
  if (last.startsWith("pass")) return "pass";
  if (last.startsWith("fail")) return "fail";
  return "needs-human"; // "needs-human", "needs human", or "human"
}

/** Extract findings from markdown bullet points and numbered items. */
export function parseFindings(text: string): string[] {
  const findings: string[] = [];
  const bulletPattern = /^[\s]*[-*•]\s+(.+)$/gm;
  const numberedPattern = /^[\s]*\d+[.)]\s+(.+)$/gm;
  let match: RegExpExecArray | null;
  while ((match = bulletPattern.exec(text)) !== null) {
    const line = match[1].trim();
    if (line.length > 10 && line.length < 500) findings.push(line);
  }
  while ((match = numberedPattern.exec(text)) !== null) {
    const line = match[1].trim();
    if (line.length > 10 && line.length < 500 && !findings.includes(line)) findings.push(line);
  }
  return findings;
}

/**
 * Fallback prose classification (no `VERDICT:` token present). Mirrors the
 * historical heuristics: explicit pass signals → passed, explicit fail signals →
 * failed, otherwise findings → failed, else ambiguous → needs-human. The
 * `madeEdits` rule stays in the extractor since it depends on tool-call inspection.
 */
export function classifyProse(text: string, findings: string[]): ProseStatus {
  const hasPassSignal = PASS_SIGNALS.some((p) => p.test(text));
  const hasFailSignal = FAIL_SIGNALS.some((p) => p.test(text));

  if (hasPassSignal && !hasFailSignal) return "passed";
  if (hasFailSignal && !hasPassSignal) return "failed";
  if (findings.length > 0) return "failed";
  return "needs-human";
}
