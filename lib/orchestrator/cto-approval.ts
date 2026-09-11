import type {
  PermissionRequestResult,
  PermissionHandler,
  SessionHooks,
} from "@github/copilot-sdk";

import type {
  CtoApprovalBinding,
  CtoContinuityStore,
} from "../db/cto-continuity-store";
import type { OrchestratorToolName } from "./orchestrator-tools";

export const CTO_APPROVAL_TTL_MS = 10 * 60_000;
export const CTO_TURN_EXECUTION_OVERHEAD_MS = 30_000;
export const CTO_MAX_TURN_TIMEOUT_MS = 15 * 60_000;

export function getCtoTurnTimeoutMs(
  approvalTtlMs = CTO_APPROVAL_TTL_MS,
  executionOverheadMs = CTO_TURN_EXECUTION_OVERHEAD_MS,
): number {
  if (!Number.isFinite(approvalTtlMs) || approvalTtlMs <= 0) {
    throw new RangeError("approval TTL must be a positive finite duration");
  }
  const boundedOverhead = Math.max(
    0,
    Math.min(executionOverheadMs, CTO_TURN_EXECUTION_OVERHEAD_MS),
  );
  return Math.min(
    CTO_MAX_TURN_TIMEOUT_MS,
    approvalTtlMs + boundedOverhead,
  );
}

function asArguments(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function approvalBinding(
  toolName: string,
  args: Record<string, unknown>,
  sdkSessionId: string,
  riskLevel: string,
  facts: Record<string, unknown>
): CtoApprovalBinding {
  const cardId = typeof args.cardId === "string" ? args.cardId : undefined;
  return {
    toolName,
    args,
    cardId,
    sdkSessionId,
    riskLevel,
    facts,
  };
}

function requiresHumanApproval(
  toolName: string,
  binding: CtoApprovalBinding
): boolean {
  return toolName === "override_phase" && binding.riskLevel === "high";
}

type PendingApproval = {
  promise: Promise<PermissionRequestResult>;
  settle(result: PermissionRequestResult, cancelPersisted?: boolean): void;
};

export interface CtoApprovalScheduler {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(callback: () => void, delayMs: number): unknown;
  clearInterval(handle: unknown): void;
}

const defaultApprovalScheduler: CtoApprovalScheduler = {
  setTimeout(callback, delayMs) {
    const timer = setTimeout(callback, delayMs);
    timer.unref();
    return timer;
  },
  clearTimeout(handle) {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
  setInterval(callback, delayMs) {
    const timer = setInterval(callback, delayMs);
    timer.unref();
    return timer;
  },
  clearInterval(handle) {
    clearInterval(handle as ReturnType<typeof setInterval>);
  },
};

const pendingByRequest = new Map<string, PendingApproval>();
const requestKeysByApproval = new Map<string, Set<string>>();

function pendingApprovalKey(
  approvalId: string,
  sdkSessionId: string,
  toolCallId: string
): string {
  return `${approvalId}:${sdkSessionId}:${toolCallId}`;
}

function settlePendingApproval(
  approvalId: string,
  result: PermissionRequestResult
): void {
  const keys = requestKeysByApproval.get(approvalId);
  if (!keys) return;
  for (const key of keys) pendingByRequest.get(key)?.settle(result);
}

export function notifyCtoApprovalDecision(
  approvalId: string,
  decision: "approved" | "rejected"
): void {
  settlePendingApproval(
    approvalId,
    decision === "approved"
      ? { kind: "approve-once", approvedInteractively: true }
      : { kind: "reject", feedback: "The human reviewer rejected this action." }
  );
}

export function hasLiveCtoApprovalWaiter(approvalId: string): boolean {
  return (requestKeysByApproval.get(approvalId)?.size ?? 0) > 0;
}

export function decideCtoApproval(
  store: CtoContinuityStore,
  decisionCapability: string,
  decision: "approved" | "rejected",
) {
  const approval = store.decideApprovalWithCapability(
    decisionCapability,
    decision,
  );
  if (approval?.ownerId === store.processOwnerId) {
    notifyCtoApprovalDecision(approval.approvalId, decision);
  }
  return approval;
}

export interface CtoPendingApprovalDecision {
  decisionCapability: string;
  toolName: string;
  cardId: string | null;
  riskLevel: string;
  action: Record<string, unknown>;
  facts: Record<string, unknown>;
  expiresAtMs: number;
}

function waitForApproval(options: {
  approvalId: string;
  sdkSessionId: string;
  toolCallId: string;
  expiresAtMs: number;
  store: CtoContinuityStore;
  signal?: AbortSignal;
  now: () => number;
  scheduler: CtoApprovalScheduler;
}): Promise<PermissionRequestResult> {
  const {
    approvalId,
    sdkSessionId,
    toolCallId,
    expiresAtMs,
    store,
    signal,
    now,
    scheduler,
  } = options;
  const key = pendingApprovalKey(approvalId, sdkSessionId, toolCallId);
  const existing = pendingByRequest.get(key);
  if (existing) return existing.promise;
  if (signal?.aborted) {
    store.cancelApproval(approvalId);
    return Promise.resolve({ kind: "user-not-available" });
  }

  let settlePromise!: (result: PermissionRequestResult) => void;
  const promise = new Promise<PermissionRequestResult>((resolve) => {
    settlePromise = resolve;
  });
  let settled = false;
  const onAbort = () => {
    pending.settle({ kind: "user-not-available" }, true);
  };
  const pending: PendingApproval = {
    promise,
    settle(result, cancelPersisted = false) {
      if (settled) return;
      settled = true;
      scheduler.clearTimeout(timer);
      scheduler.clearInterval(ownerTimer);
      scheduler.clearInterval(decisionTimer);
      signal?.removeEventListener("abort", onAbort);
      pendingByRequest.delete(key);
      const keys = requestKeysByApproval.get(approvalId);
      keys?.delete(key);
      if (keys?.size === 0) {
        requestKeysByApproval.delete(approvalId);
        if (cancelPersisted) store.cancelApproval(approvalId);
      }
      settlePromise(result);
    },
  };
  pendingByRequest.set(key, pending);
  const keys = requestKeysByApproval.get(approvalId) ?? new Set<string>();
  keys.add(key);
  requestKeysByApproval.set(approvalId, keys);

  const timer = scheduler.setTimeout(() => {
    pending.settle({
      kind: "reject",
      feedback: "The human approval request expired.",
    }, true);
  }, Math.max(0, expiresAtMs - now()));
  const ownerTimer = scheduler.setInterval(() => {
    if (!store.renewApprovalOwner(approvalId)) {
      pending.settle({ kind: "user-not-available" }, true);
    }
  }, store.approvalOwnerRenewalIntervalMs);
  const decisionTimer = scheduler.setInterval(() => {
    const approval = store.getApproval(approvalId);
    if (approval?.status === "approved") {
      pending.settle({
        kind: "approve-once",
        approvedInteractively: true,
      });
    } else if (approval?.status === "rejected") {
      pending.settle({
        kind: "reject",
        feedback: "The human reviewer rejected this action.",
      });
    } else if (!approval || approval.status === "expired") {
      pending.settle({ kind: "user-not-available" });
    }
  }, 100);
  signal?.addEventListener("abort", onAbort, { once: true });
  return promise;
}

export function createCtoPermissionPolicy(options: {
  store: CtoContinuityStore;
  resolveBinding: (
    toolName: string,
    args: Record<string, unknown>,
    sdkSessionId: string
  ) => CtoApprovalBinding | null;
  signal?: AbortSignal;
  approvalTtlMs?: number;
  now?: () => number;
  scheduler?: CtoApprovalScheduler;
  onApprovalRequired?: (approval: CtoPendingApprovalDecision) => void;
}): {
  onPermissionRequest: PermissionHandler;
  hooks: SessionHooks;
  cancelPending(): void;
} {
  const { store } = options;
  const approvalTtlMs = options.approvalTtlMs ?? CTO_APPROVAL_TTL_MS;
  const now = options.now ?? Date.now;
  const scheduler = options.scheduler ?? defaultApprovalScheduler;
  const policyAbort = new AbortController();
  const abortPolicy = () => policyAbort.abort();
  options.signal?.addEventListener("abort", abortPolicy, { once: true });

  const onPermissionRequest: PermissionHandler = async (request, invocation) => {
    if (request.kind !== "custom-tool") {
      if (request.managedApprovalRequired) {
        const binding = {
          toolName: request.kind,
          args: { toolCallId: request.toolCallId ?? "unknown" },
          sdkSessionId: invocation.sessionId,
          riskLevel: "managed",
          facts: { managedApprovalRequired: true },
        };
        const requested = store.requestApproval(
          binding,
          "cto-agent",
          approvalTtlMs,
          request.toolCallId ?? "managed"
        );
        const { approval } = requested;
        if (approval.status === "approved") {
          const consumed = store.consumeApproval(
            binding,
            request.toolCallId ?? "managed"
          );
          return consumed
            ? { kind: "approve-once", approvedInteractively: true }
            : { kind: "user-not-available" };
        }
        const pendingDecision = waitForApproval({
          approvalId: approval.approvalId,
          sdkSessionId: invocation.sessionId,
          toolCallId: request.toolCallId ?? "managed",
          expiresAtMs: approval.expiresAtMs,
          store,
          signal: policyAbort.signal,
          now,
          scheduler,
        });
        options.onApprovalRequired?.({
          decisionCapability: requested.decisionCapability,
          toolName: approval.toolName,
          cardId: approval.cardId,
          riskLevel: approval.riskLevel,
          action: binding.args,
          facts: binding.facts,
          expiresAtMs: approval.expiresAtMs,
        });
        const decision = await pendingDecision;
        if (decision.kind !== "approve-once") return decision;
        return store.consumeApproval(
          binding,
          request.toolCallId ?? "managed"
        )
          ? decision
          : { kind: "user-not-available" };
      }
      return {
        kind: "reject",
        feedback: "Planwerk only permits its registered CTO tools.",
      };
    }

    const args = asArguments(request.args);
    const authoritativeBinding = options.resolveBinding(
      request.toolName,
      args,
      invocation.sessionId
    );
    const binding = authoritativeBinding ??
      (request.toolName === "override_phase"
        ? null
        : approvalBinding(
            request.toolName,
            args,
            invocation.sessionId,
            "not-applicable",
            {}
          ));
    if (!binding) {
      return {
        kind: "reject",
        feedback:
          "No current persisted server-side risk assessment exists for this action.",
      };
    }
    if (!request.managedApprovalRequired &&
        !requiresHumanApproval(request.toolName, binding)) {
      return { kind: "approve-once" };
    }

    const toolCallId = request.toolCallId ?? "unknown";
    const consumed = store.consumeApproval(binding, toolCallId);
    if (consumed) {
      return { kind: "approve-once", approvedInteractively: true };
    }

    const requested = store.requestApproval(
      binding,
      "cto-agent",
      approvalTtlMs,
      toolCallId
    );
    const { approval } = requested;
    if (approval.status === "approved") {
      const approved = store.consumeApproval(binding, toolCallId);
      return approved
        ? { kind: "approve-once", approvedInteractively: true }
        : { kind: "user-not-available" };
    }
    const pendingDecision = waitForApproval({
      approvalId: approval.approvalId,
      sdkSessionId: invocation.sessionId,
      toolCallId,
      expiresAtMs: approval.expiresAtMs,
      store,
      signal: policyAbort.signal,
      now,
      scheduler,
    });
    options.onApprovalRequired?.({
      decisionCapability: requested.decisionCapability,
      toolName: approval.toolName,
      cardId: approval.cardId,
      riskLevel: approval.riskLevel,
      action: binding.args,
      facts: binding.facts,
      expiresAtMs: approval.expiresAtMs,
    });
    const decision = await pendingDecision;
    if (decision.kind !== "approve-once") return decision;

    const currentBinding = options.resolveBinding(
      request.toolName,
      args,
      invocation.sessionId
    ) ?? (request.toolName === "override_phase"
      ? null
      : binding);
    if (!currentBinding) {
      return {
        kind: "reject",
        feedback: "The persisted risk assessment is no longer available.",
      };
    }
    const newlyConsumed = store.consumeApproval(currentBinding, toolCallId);
    return newlyConsumed
      ? { kind: "approve-once", approvedInteractively: true }
      : {
          kind: "reject",
          feedback:
            "Authoritative card facts changed while approval was pending.",
        };
  };

  const hooks: SessionHooks = {
    onPreToolUse: (input, invocation) => {
      const binding = options.resolveBinding(
        input.toolName,
        asArguments(input.toolArgs),
        invocation.sessionId
      );
      if (!binding && input.toolName === "override_phase") {
        return {
          permissionDecision: "deny",
          permissionDecisionReason:
            "A persisted server-side risk assessment is required.",
        };
      }
      if (binding && requiresHumanApproval(input.toolName, binding)) {
        return {
          permissionDecision: "ask",
          permissionDecisionReason:
            "High-risk phase overrides require a current human approval.",
        };
      }
      return { permissionDecision: "allow" };
    },
  };

  return {
    onPermissionRequest,
    hooks,
    cancelPending() {
      options.signal?.removeEventListener("abort", abortPolicy);
      policyAbort.abort();
    },
  };
}

export function isApprovalRequiredTool(
  toolName: OrchestratorToolName
): boolean {
  return toolName === "override_phase";
}
