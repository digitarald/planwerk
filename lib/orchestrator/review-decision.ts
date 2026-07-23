import type { ReviewVerdict } from "./verdict-judge-core.ts";

export type ReviewAction = "passed" | "re-iterate" | "escalated";

export function decideReviewAction(
  verdict: ReviewVerdict,
  iteration: number,
  maxIterations: number,
  followEdits: boolean
): ReviewAction {
  if (verdict.status === "needs-human") return "escalated";
  if (verdict.status === "passed") {
    return verdict.madeEdits && followEdits && iteration < maxIterations
      ? "re-iterate"
      : "passed";
  }
  return iteration < maxIterations ? "re-iterate" : "escalated";
}
