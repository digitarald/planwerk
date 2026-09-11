import type { CtoContinuityStore } from "../db/cto-continuity-store";
import type { ToolCallResult } from "./orchestrator-tools";

export type ToolExecutionDisposition =
  | "retryable"
  | "terminal"
  | "needs-human";

export interface ToolHandlerOutcome {
  result: ToolCallResult;
  disposition: ToolExecutionDisposition;
}

export function toolLeaseFailureOutcome(
  toolName: string,
  failure: unknown,
): ToolHandlerOutcome {
  const detail = failure instanceof Error ? failure.message : String(failure);
  const retryable =
    toolName === "create_session" || toolName === "assess_risk";
  return {
    result: {
      success: false,
      message:
        `Tool execution lease renewal failed: ${detail}` +
        (retryable
          ? ""
          : " The side effect may have occurred; human review is required before retrying."),
    },
    disposition: retryable ? "retryable" : "needs-human",
  };
}

export function persistToolHandlerOutcome(
  store: CtoContinuityStore,
  idempotencyKey: string,
  ownerId: string,
  outcome: ToolHandlerOutcome
): void {
  if (!outcome.result.success && outcome.disposition === "retryable") {
    store.abandonToolExecution(idempotencyKey, ownerId);
    return;
  }
  if (!outcome.result.success && outcome.disposition === "needs-human") {
    store.markOwnedToolExecutionNeedsHuman(
      idempotencyKey,
      ownerId,
      outcome.result
    );
    return;
  }
  store.completeToolExecution(idempotencyKey, ownerId, outcome.result);
}
