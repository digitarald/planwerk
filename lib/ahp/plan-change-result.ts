/**
 * The terminal outcome of asking an agent to revise a plan.
 *
 * A dispatch followed by a successful ping proves the critique reached the
 * host transport, but not that the host consumed the input. Retrying that
 * outcome would decline the revised plan again, so it is deliberately a
 * delivered outcome rather than a failure.
 */
export type PlanChangeResult =
  | { outcome: "confirmed"; followUpRequestId: string }
  | { outcome: "delivered-unconfirmed"; followUpRequestId: string }
  | { outcome: "stale" }
  | { outcome: "undelivered" };

export function isPlanChangeDelivered(
  result: PlanChangeResult,
): result is Extract<PlanChangeResult, { outcome: "confirmed" | "delivered-unconfirmed" }> {
  return result.outcome === "confirmed" || result.outcome === "delivered-unconfirmed";
}

export function isPlanChangeConfirmed(result: PlanChangeResult): boolean {
  return result.outcome === "confirmed";
}
