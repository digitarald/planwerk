import "server-only";

import type { Turn } from "@microsoft/agent-host-protocol";
import {
  evaluateVerdict,
  type ReviewVerdict,
} from "./verdict-evaluator";

export type { ReviewVerdict };

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
  return evaluateVerdict(turns);
}
