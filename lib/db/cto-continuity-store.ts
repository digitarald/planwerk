import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";

import type Database from "better-sqlite3";

export type ApprovalStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "consumed"
  | "expired";

export interface CtoSessionRecord {
  sessionId: string;
  modelId: string;
}

export interface CtoSessionBinding extends CtoSessionRecord {
  lifecycleState: "active" | "deleting";
  deletionToken: string | null;
  deletionStartedAtMs: number | null;
}

export interface CtoApprovalBinding {
  toolName: string;
  args: Record<string, unknown>;
  cardId?: string;
  sdkSessionId: string;
  riskLevel: string;
  facts: Record<string, unknown>;
}

export interface CtoApproval {
  approvalId: string;
  actionHash: string;
  toolName: string;
  cardId: string | null;
  sdkSessionId: string;
  riskLevel: string;
  facts: Record<string, unknown>;
  requestedBy: string;
  ownerId: string | null;
  requestedToolCallId: string | null;
  status: ApprovalStatus;
  expiresAtMs: number;
  createdAtMs: number;
  decidedAtMs: number | null;
  decidedBy: string | null;
  consumedAtMs: number | null;
  consumedToolCallId: string | null;
}

export interface CtoApprovalRequest {
  approval: CtoApproval;
  decisionCapability: string;
}

export type ToolExecutionClaim<TResult> =
  | { state: "claimed" }
  | { state: "completed"; result: TResult }
  | { state: "needs-human"; result: TResult }
  | { state: "in-progress"; leaseExpiresAtMs: number }
  | {
      state: "recovery-required";
      previousOwnerId: string;
      startedAtMs: number;
    };

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)])
    );
  }
  return value;
}

export function stableJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function hashCtoAction(binding: CtoApprovalBinding): string {
  return createHash("sha256")
    .update(stableJson({
      toolName: binding.toolName,
      args: binding.args,
      cardId: binding.cardId ?? null,
      sdkSessionId: binding.sdkSessionId,
      riskLevel: binding.riskLevel,
      facts: binding.facts,
    }))
    .digest("hex");
}

interface ApprovalRow {
  approval_id: string;
  action_hash: string;
  tool_name: string;
  card_id: string | null;
  sdk_session_id: string;
  risk_level: string;
  facts_json: string;
  requested_by: string;
  owner_id: string | null;
  requested_tool_call_id: string | null;
  decision_capability_hash: string | null;
  status: ApprovalStatus;
  expires_at_ms: number;
  created_at_ms: number;
  decided_at_ms: number | null;
  decided_by: string | null;
  consumed_at_ms: number | null;
  consumed_tool_call_id: string | null;
}

const LOCAL_DECISION_ACTOR = "local-human";

function hashDecisionCapability(
  capability: string,
  row: Pick<
    ApprovalRow,
    | "approval_id"
    | "action_hash"
    | "sdk_session_id"
    | "owner_id"
    | "requested_tool_call_id"
    | "expires_at_ms"
  >,
): Buffer {
  return createHash("sha256")
    .update(stableJson({
      purpose: "planwerk-cto-decision-v1",
      capability,
      approvalId: row.approval_id,
      actionHash: row.action_hash,
      sdkSessionId: row.sdk_session_id,
      ownerId: row.owner_id,
      toolCallId: row.requested_tool_call_id,
      expiresAtMs: row.expires_at_ms,
    }))
    .digest();
}

function mapApproval(row: ApprovalRow): CtoApproval {
  return {
    approvalId: row.approval_id,
    actionHash: row.action_hash,
    toolName: row.tool_name,
    cardId: row.card_id,
    sdkSessionId: row.sdk_session_id,
    riskLevel: row.risk_level,
    facts: JSON.parse(row.facts_json) as Record<string, unknown>,
    requestedBy: row.requested_by,
    ownerId: row.owner_id,
    requestedToolCallId: row.requested_tool_call_id,
    status: row.status,
    expiresAtMs: row.expires_at_ms,
    createdAtMs: row.created_at_ms,
    decidedAtMs: row.decided_at_ms,
    decidedBy: row.decided_by,
    consumedAtMs: row.consumed_at_ms,
    consumedToolCallId: row.consumed_tool_call_id,
  };
}

export interface CtoContinuityStoreOptions {
  ownerId?: string;
  ownerLeaseTtlMs?: number;
}

export class CtoContinuityStore {
  private readonly db: Database.Database;
  private readonly now: () => number;
  private readonly ownerId: string;
  private readonly ownerLeaseTtlMs: number;
  private readonly decisionCapabilities = new Map<string, string>();

  constructor(
    db: Database.Database,
    now: () => number = Date.now,
    options: CtoContinuityStoreOptions = {},
  ) {
    this.db = db;
    this.now = now;
    this.ownerId = options.ownerId ?? randomUUID();
    this.ownerLeaseTtlMs = options.ownerLeaseTtlMs ?? 30_000;
    this.expireApprovals(this.now());
  }

  get approvalOwnerRenewalIntervalMs(): number {
    return Math.max(1, Math.floor(this.ownerLeaseTtlMs / 3));
  }

  get processOwnerId(): string {
    return this.ownerId;
  }

  getSession(): CtoSessionRecord | null {
    const binding = this.getSessionBinding();
    return binding?.lifecycleState === "active"
      ? { sessionId: binding.sessionId, modelId: binding.modelId }
      : null;
  }

  getSessionBinding(): CtoSessionBinding | null {
    const row = this.db.prepare(`
      SELECT sdk_session_id, model_id, lifecycle_state, deletion_token,
        deletion_started_at_ms
      FROM cto_sdk_sessions WHERE singleton_key = 'primary'
    `).get() as {
      sdk_session_id: string;
      model_id: string;
      lifecycle_state: "active" | "deleting";
      deletion_token: string | null;
      deletion_started_at_ms: number | null;
    } | undefined;
    return row
      ? {
          sessionId: row.sdk_session_id,
          modelId: row.model_id,
          lifecycleState: row.lifecycle_state,
          deletionToken: row.deletion_token,
          deletionStartedAtMs: row.deletion_started_at_ms,
        }
      : null;
  }

  setSession(sessionId: string, modelId: string): void {
    const result = this.db.prepare(`
      INSERT INTO cto_sdk_sessions (
        singleton_key, sdk_session_id, model_id, lifecycle_state,
        deletion_token, deletion_started_at_ms, created_at, updated_at
      ) VALUES (
        'primary', ?, ?, 'active', NULL, NULL, datetime('now'), datetime('now')
      )
      ON CONFLICT(singleton_key) DO UPDATE SET
        sdk_session_id = excluded.sdk_session_id,
        model_id = excluded.model_id,
        lifecycle_state = 'active',
        deletion_token = NULL,
        deletion_started_at_ms = NULL,
        updated_at = datetime('now')
      WHERE cto_sdk_sessions.lifecycle_state = 'active'
    `).run(sessionId, modelId);
    if (result.changes !== 1) {
      throw new Error("CTO session binding is quarantined for deletion");
    }
  }

  setSessionIfLeaseOwner(
    sessionId: string,
    modelId: string,
    resourceKey: string,
    ownerId: string,
  ): boolean {
    const now = this.now();
    const update = this.db.transaction(() => {
      const owned = this.db.prepare(`
        SELECT 1 FROM cto_session_leases
        WHERE resource_key = ? AND owner_id = ? AND expires_at_ms > ?
      `).get(resourceKey, ownerId, now);
      if (!owned) return false;
      const existing = this.getSessionBinding();
      if (existing?.lifecycleState === "deleting") return false;
      this.setSession(sessionId, modelId);
      return true;
    });
    return update.immediate();
  }

  clearSession(expectedSessionId?: string): boolean {
    const result = expectedSessionId
      ? this.db.prepare(`
          DELETE FROM cto_sdk_sessions
          WHERE singleton_key = 'primary' AND sdk_session_id = ?
        `).run(expectedSessionId)
      : this.db.prepare(`
          DELETE FROM cto_sdk_sessions WHERE singleton_key = 'primary'
        `).run();
    return result.changes === 1;
  }

  clearSessionIfLeaseOwner(
    expectedSessionId: string,
    resourceKey: string,
    ownerId: string,
  ): boolean {
    const now = this.now();
    return this.db.prepare(`
      DELETE FROM cto_sdk_sessions
      WHERE singleton_key = 'primary' AND sdk_session_id = ?
        AND EXISTS (
          SELECT 1 FROM cto_session_leases
          WHERE resource_key = ? AND owner_id = ? AND expires_at_ms > ?
        )
    `).run(expectedSessionId, resourceKey, ownerId, now).changes === 1;
  }

  hasLease(resourceKey: string, ownerId: string): boolean {
    return Boolean(this.db.prepare(`
      SELECT 1 FROM cto_session_leases
      WHERE resource_key = ? AND owner_id = ? AND expires_at_ms > ?
    `).get(resourceKey, ownerId, this.now()));
  }

  quarantineSessionForDeletion(
    expectedSessionId: string,
    resourceKey: string,
    ownerId: string,
    deletionToken: string,
  ): boolean {
    const now = this.now();
    return this.db.prepare(`
      UPDATE cto_sdk_sessions
      SET lifecycle_state = 'deleting', deletion_token = ?,
        deletion_started_at_ms = ?, updated_at = datetime('now')
      WHERE singleton_key = 'primary' AND sdk_session_id = ?
        AND lifecycle_state IN ('active', 'deleting')
        AND EXISTS (
          SELECT 1 FROM cto_session_leases
          WHERE resource_key = ? AND owner_id = ? AND expires_at_ms > ?
        )
    `).run(
      deletionToken,
      now,
      expectedSessionId,
      resourceKey,
      ownerId,
      now,
    ).changes === 1;
  }

  clearQuarantinedSession(
    expectedSessionId: string,
    deletionToken: string,
    resourceKey: string,
    ownerId: string,
  ): boolean {
    const now = this.now();
    return this.db.prepare(`
      DELETE FROM cto_sdk_sessions
      WHERE singleton_key = 'primary' AND sdk_session_id = ?
        AND lifecycle_state = 'deleting' AND deletion_token = ?
        AND EXISTS (
          SELECT 1 FROM cto_session_leases
          WHERE resource_key = ? AND owner_id = ? AND expires_at_ms > ?
        )
    `).run(
      expectedSessionId,
      deletionToken,
      resourceKey,
      ownerId,
      now,
    ).changes === 1;
  }

  restoreQuarantinedSession(
    expectedSessionId: string,
    deletionToken: string,
    resourceKey: string,
    ownerId: string,
  ): boolean {
    const now = this.now();
    return this.db.prepare(`
      UPDATE cto_sdk_sessions
      SET lifecycle_state = 'active', deletion_token = NULL,
        deletion_started_at_ms = NULL, updated_at = datetime('now')
      WHERE singleton_key = 'primary' AND sdk_session_id = ?
        AND lifecycle_state = 'deleting' AND deletion_token = ?
        AND EXISTS (
          SELECT 1 FROM cto_session_leases
          WHERE resource_key = ? AND owner_id = ? AND expires_at_ms > ?
        )
    `).run(
      expectedSessionId,
      deletionToken,
      resourceKey,
      ownerId,
      now,
    ).changes === 1;
  }

  acquireLease(resourceKey: string, ownerId: string, ttlMs: number): boolean {
    const now = this.now();
    const result = this.db.prepare(`
      INSERT INTO cto_session_leases (
        resource_key, owner_id, acquired_at_ms, expires_at_ms
      ) VALUES (?, ?, ?, ?)
      ON CONFLICT(resource_key) DO UPDATE SET
        owner_id = excluded.owner_id,
        acquired_at_ms = excluded.acquired_at_ms,
        expires_at_ms = excluded.expires_at_ms
      WHERE cto_session_leases.expires_at_ms <= excluded.acquired_at_ms
         OR cto_session_leases.owner_id = excluded.owner_id
    `).run(resourceKey, ownerId, now, now + ttlMs);
    return result.changes === 1;
  }

  renewLease(resourceKey: string, ownerId: string, ttlMs: number): boolean {
    const now = this.now();
    const result = this.db.prepare(`
      UPDATE cto_session_leases
      SET expires_at_ms = ?
      WHERE resource_key = ? AND owner_id = ? AND expires_at_ms > ?
    `).run(now + ttlMs, resourceKey, ownerId, now);
    return result.changes === 1;
  }

  releaseLease(resourceKey: string, ownerId: string): boolean {
    return this.db.prepare(`
      DELETE FROM cto_session_leases
      WHERE resource_key = ? AND owner_id = ?
    `).run(resourceKey, ownerId).changes === 1;
  }

  requestApproval(
    binding: CtoApprovalBinding,
    requestedBy: string,
    ttlMs: number,
    toolCallId: string
  ): CtoApprovalRequest {
    const now = this.now();
    const actionHash = hashCtoAction(binding);
    const request = this.db.transaction(() => {
      this.expireApprovals(now);
      this.activateOwnerLease(now);

      const existing = this.db.prepare(`
        SELECT * FROM cto_action_approvals
        WHERE action_hash = ? AND requested_tool_call_id = ?
          AND owner_id = ?
          AND status IN ('pending', 'approved')
          AND expires_at_ms > ?
        ORDER BY created_at_ms DESC LIMIT 1
      `).get(
        actionHash,
        toolCallId,
        this.ownerId,
        now,
      ) as ApprovalRow | undefined;
      if (existing) {
        const decisionCapability =
          this.decisionCapabilities.get(existing.approval_id);
        if (decisionCapability) {
          return {
            approval: mapApproval(existing),
            decisionCapability,
          };
        }
        this.db.prepare(`
          UPDATE cto_action_approvals SET status = 'expired'
          WHERE approval_id = ? AND status IN ('pending', 'approved')
        `).run(existing.approval_id);
      }

      const approvalId = randomUUID();
      const decisionCapability = randomBytes(32).toString("base64url");
      const expiresAtMs = now + ttlMs;
      const capabilityHash = hashDecisionCapability(decisionCapability, {
        approval_id: approvalId,
        action_hash: actionHash,
        sdk_session_id: binding.sdkSessionId,
        owner_id: this.ownerId,
        requested_tool_call_id: toolCallId,
        expires_at_ms: expiresAtMs,
      }).toString("hex");
      this.db.prepare(`
        INSERT INTO cto_action_approvals (
          approval_id, action_hash, tool_name, card_id, sdk_session_id,
          risk_level, facts_json, requested_by, owner_id,
          requested_tool_call_id, decision_capability_hash, status,
          expires_at_ms, created_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
      `).run(
        approvalId,
        actionHash,
        binding.toolName,
        binding.cardId ?? null,
        binding.sdkSessionId,
        binding.riskLevel,
        stableJson(binding.facts),
        requestedBy,
        this.ownerId,
        toolCallId,
        capabilityHash,
        expiresAtMs,
        now,
      );
      this.decisionCapabilities.set(approvalId, decisionCapability);
      return {
        approval: this.getApproval(approvalId)!,
        decisionCapability,
      };
    });
    return request.immediate();
  }

  decideApprovalWithCapability(
    capability: string,
    decision: "approved" | "rejected",
  ): CtoApproval | null {
    const now = this.now();
    this.expireApprovals(now);
    if (
      typeof capability !== "string" ||
      capability.length < 32 ||
      capability.length > 128
    ) {
      return null;
    }

    const candidates = this.db.prepare(`
      SELECT * FROM cto_action_approvals
      WHERE status = 'pending'
        AND decision_capability_hash IS NOT NULL
        AND expires_at_ms > ?
        AND EXISTS (
          SELECT 1 FROM cto_process_owners
          WHERE cto_process_owners.owner_id = cto_action_approvals.owner_id
            AND cto_process_owners.expires_at_ms > ?
        )
    `).all(now, now) as ApprovalRow[];

    let match: ApprovalRow | undefined;
    for (const candidate of candidates) {
      const stored = Buffer.from(
        candidate.decision_capability_hash ?? "",
        "hex",
      );
      const presented = hashDecisionCapability(capability, candidate);
      const equal = stored.length === presented.length &&
        timingSafeEqual(stored, presented);
      if (equal) match = candidate;
    }
    if (!match) return null;

    const decide = this.db.transaction(() => {
      const result = this.db.prepare(`
        UPDATE cto_action_approvals
        SET status = ?, decided_at_ms = ?, decided_by = ?
        WHERE approval_id = ? AND action_hash = ? AND sdk_session_id = ?
          AND owner_id = ? AND requested_tool_call_id = ?
          AND status = 'pending' AND expires_at_ms > ?
          AND EXISTS (
            SELECT 1 FROM cto_process_owners
            WHERE cto_process_owners.owner_id =
              cto_action_approvals.owner_id
              AND cto_process_owners.expires_at_ms > ?
          )
      `).run(
        decision,
        now,
        LOCAL_DECISION_ACTOR,
        match.approval_id,
        match.action_hash,
        match.sdk_session_id,
        match.owner_id,
        match.requested_tool_call_id,
        now,
        now,
      );
      return result.changes === 1
        ? this.getApproval(match.approval_id)
        : null;
    });
    const approval = decide.immediate();
    return approval;
  }

  expireApproval(approvalId: string): CtoApproval | null {
    const now = this.now();
    const result = this.db.prepare(`
      UPDATE cto_action_approvals
      SET status = 'expired'
      WHERE approval_id = ? AND status IN ('pending', 'approved')
        AND expires_at_ms <= ?
    `).run(approvalId, now);
    return result.changes === 1 ? this.getApproval(approvalId) : null;
  }

  cancelApproval(approvalId: string): CtoApproval | null {
    const result = this.db.prepare(`
      UPDATE cto_action_approvals
      SET status = 'expired'
      WHERE approval_id = ? AND status IN ('pending', 'approved')
        AND owner_id = ?
    `).run(approvalId, this.ownerId);
    if (result.changes === 1) {
      this.decisionCapabilities.delete(approvalId);
      return this.getApproval(approvalId);
    }
    return null;
  }

  consumeApproval(
    binding: CtoApprovalBinding,
    toolCallId: string
  ): CtoApproval | null {
    const consume = this.db.transaction(() => {
      const now = this.now();
      const actionHash = hashCtoAction(binding);
      this.expireApprovals(now);
      const row = this.db.prepare(`
        SELECT approval_id FROM cto_action_approvals
        WHERE action_hash = ? AND requested_tool_call_id = ?
          AND owner_id = ? AND status = 'approved' AND expires_at_ms > ?
          AND EXISTS (
            SELECT 1 FROM cto_process_owners
            WHERE cto_process_owners.owner_id = cto_action_approvals.owner_id
              AND cto_process_owners.expires_at_ms > ?
          )
        ORDER BY decided_at_ms ASC LIMIT 1
      `).get(
        actionHash,
        toolCallId,
        this.ownerId,
        now,
        now,
      ) as { approval_id: string } | undefined;
      if (!row) return null;

      const result = this.db.prepare(`
        UPDATE cto_action_approvals
        SET status = 'consumed', consumed_at_ms = ?, consumed_tool_call_id = ?
        WHERE approval_id = ? AND owner_id = ?
          AND status = 'approved' AND expires_at_ms > ?
          AND EXISTS (
            SELECT 1 FROM cto_process_owners
            WHERE owner_id = ? AND expires_at_ms > ?
          )
      `).run(
        now,
        toolCallId,
        row.approval_id,
        this.ownerId,
        now,
        this.ownerId,
        now,
      );
      if (result.changes !== 1) return null;
      // Keep the same live process owner valid for the short SDK hand-off from
      // permission completion to the owner-fenced mutation.
      this.db.prepare(`
        UPDATE cto_process_owners
        SET expires_at_ms = ?, updated_at_ms = ?
        WHERE owner_id = ? AND expires_at_ms > ?
      `).run(now + this.ownerLeaseTtlMs, now, this.ownerId, now);
      this.decisionCapabilities.delete(row.approval_id);
      return this.getApproval(row.approval_id);
    });
    return consume.immediate();
  }

  hasConsumedApproval(
    binding: CtoApprovalBinding,
    toolCallId: string
  ): boolean {
    const now = this.now();
    return Boolean(this.db.prepare(`
      SELECT 1 FROM cto_action_approvals
      WHERE action_hash = ? AND status = 'consumed'
        AND requested_tool_call_id = ? AND consumed_tool_call_id = ?
        AND owner_id = ? AND expires_at_ms > ?
        AND EXISTS (
          SELECT 1 FROM cto_process_owners
          WHERE cto_process_owners.owner_id =
            cto_action_approvals.owner_id
            AND cto_process_owners.expires_at_ms > ?
        )
    `).get(
      hashCtoAction(binding),
      toolCallId,
      toolCallId,
      this.ownerId,
      now,
      now,
    ));
  }

  getApproval(approvalId: string): CtoApproval | null {
    const row = this.db.prepare(`
      SELECT * FROM cto_action_approvals WHERE approval_id = ?
    `).get(approvalId) as ApprovalRow | undefined;
    return row ? mapApproval(row) : null;
  }

  listApprovals(status?: ApprovalStatus): CtoApproval[] {
    this.expireApprovals(this.now());
    const rows = (status
      ? this.db.prepare(`
          SELECT * FROM cto_action_approvals
          WHERE status = ? ORDER BY created_at_ms DESC
        `).all(status)
      : this.db.prepare(`
          SELECT * FROM cto_action_approvals ORDER BY created_at_ms DESC
        `).all()) as ApprovalRow[];
    return rows.map(mapApproval);
  }

  renewApprovalOwner(approvalId: string): boolean {
    const now = this.now();
    const result = this.db.prepare(`
      UPDATE cto_process_owners
      SET expires_at_ms = ?, updated_at_ms = ?
      WHERE owner_id = ? AND expires_at_ms > ?
        AND EXISTS (
          SELECT 1 FROM cto_action_approvals
          WHERE approval_id = ? AND owner_id = ?
            AND status IN ('pending', 'approved')
            AND expires_at_ms > ?
        )
    `).run(
      now + this.ownerLeaseTtlMs,
      now,
      this.ownerId,
      now,
      approvalId,
      this.ownerId,
      now,
    );
    return result.changes === 1;
  }

  claimToolExecution<TResult>(
    idempotencyKey: string,
    toolName: string,
    args: Record<string, unknown>,
    ownerId: string,
    leaseTtlMs: number
  ): ToolExecutionClaim<TResult> {
    const now = this.now();
    const actionHash = createHash("sha256")
      .update(stableJson({ toolName, args }))
      .digest("hex");
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO cto_tool_executions (
        idempotency_key, tool_name, action_hash, status, owner_id,
        lease_expires_at_ms, attempt_count, started_at_ms, updated_at_ms
      ) VALUES (?, ?, ?, 'running', ?, ?, 1, ?, ?)
    `).run(
      idempotencyKey,
      toolName,
      actionHash,
      ownerId,
      now + leaseTtlMs,
      now,
      now
    );
    if (result.changes === 1) return { state: "claimed" };

    const row = this.db.prepare(`
      SELECT tool_name, action_hash, status, result_json, owner_id,
        lease_expires_at_ms, started_at_ms
      FROM cto_tool_executions WHERE idempotency_key = ?
    `).get(idempotencyKey) as {
      tool_name: string;
      action_hash: string;
      status: "running" | "completed" | "needs-human";
      result_json: string | null;
      owner_id: string;
      lease_expires_at_ms: number;
      started_at_ms: number;
    };
    if (row.tool_name !== toolName || row.action_hash !== actionHash) {
      throw new Error("idempotency key reused for a different tool action");
    }
    if (row.status === "running") {
      if (row.lease_expires_at_ms > now) {
        return {
          state: "in-progress",
          leaseExpiresAtMs: row.lease_expires_at_ms,
        };
      }
      return {
        state: "recovery-required",
        previousOwnerId: row.owner_id,
        startedAtMs: row.started_at_ms,
      };
    }
    return {
      state: row.status,
      result: JSON.parse(row.result_json ?? "null") as TResult,
    };
  }

  recoverToolExecution(
    idempotencyKey: string,
    ownerId: string,
    leaseTtlMs: number
  ): boolean {
    const now = this.now();
    return this.db.prepare(`
      UPDATE cto_tool_executions
      SET owner_id = ?, lease_expires_at_ms = ?, attempt_count = attempt_count + 1,
        updated_at_ms = ?
      WHERE idempotency_key = ? AND status = 'running'
        AND lease_expires_at_ms <= ?
    `).run(ownerId, now + leaseTtlMs, now, idempotencyKey, now).changes === 1;
  }

  renewToolExecution(
    idempotencyKey: string,
    ownerId: string,
    leaseTtlMs: number
  ): boolean {
    const now = this.now();
    return this.db.prepare(`
      UPDATE cto_tool_executions
      SET lease_expires_at_ms = ?, updated_at_ms = ?
      WHERE idempotency_key = ? AND owner_id = ? AND status = 'running'
        AND lease_expires_at_ms > ?
    `).run(
      now + leaseTtlMs,
      now,
      idempotencyKey,
      ownerId,
      now
    ).changes === 1;
  }

  abandonToolExecution(idempotencyKey: string, ownerId: string): boolean {
    return this.db.prepare(`
      DELETE FROM cto_tool_executions
      WHERE idempotency_key = ? AND owner_id = ? AND status = 'running'
    `).run(idempotencyKey, ownerId).changes === 1;
  }

  markToolExecutionNeedsHuman<TResult>(
    idempotencyKey: string,
    resultValue: TResult
  ): void {
    const now = this.now();
    const result = this.db.prepare(`
      UPDATE cto_tool_executions
      SET status = 'needs-human', result_json = ?, updated_at_ms = ?,
        completed_at_ms = ?
      WHERE idempotency_key = ? AND status = 'running'
        AND lease_expires_at_ms <= ?
    `).run(
      stableJson(resultValue),
      now,
      now,
      idempotencyKey,
      now
    );
    if (result.changes !== 1) {
      throw new Error("expired tool execution could not be reconciled");
    }
  }

  markOwnedToolExecutionNeedsHuman<TResult>(
    idempotencyKey: string,
    ownerId: string,
    resultValue: TResult
  ): void {
    const now = this.now();
    const result = this.db.prepare(`
      UPDATE cto_tool_executions
      SET status = 'needs-human', result_json = ?, updated_at_ms = ?,
        completed_at_ms = ?
      WHERE idempotency_key = ? AND owner_id = ? AND status = 'running'
    `).run(
      stableJson(resultValue),
      now,
      now,
      idempotencyKey,
      ownerId
    );
    if (result.changes !== 1) {
      throw new Error("owned tool execution could not be marked needs-human");
    }
  }

  completeToolExecution<TResult>(
    idempotencyKey: string,
    ownerId: string,
    resultValue: TResult
  ): void {
    const now = this.now();
    const result = this.db.prepare(`
      UPDATE cto_tool_executions
      SET status = 'completed', result_json = ?, updated_at_ms = ?,
        completed_at_ms = ?
      WHERE idempotency_key = ? AND owner_id = ? AND status = 'running'
        AND lease_expires_at_ms > ?
    `).run(
      stableJson(resultValue),
      now,
      now,
      idempotencyKey,
      ownerId,
      now
    );
    if (result.changes !== 1) {
      throw new Error(
        "tool execution ownership was lost or it was already completed"
      );
    }
  }

  private activateOwnerLease(now: number): void {
    this.db.prepare(`
      INSERT INTO cto_process_owners (
        owner_id, acquired_at_ms, expires_at_ms, updated_at_ms
      ) VALUES (?, ?, ?, ?)
      ON CONFLICT(owner_id) DO UPDATE SET
        acquired_at_ms = excluded.acquired_at_ms,
        expires_at_ms = excluded.expires_at_ms,
        updated_at_ms = excluded.updated_at_ms
    `).run(
      this.ownerId,
      now,
      now + this.ownerLeaseTtlMs,
      now,
    );
  }

  private expireApprovals(now: number): void {
    this.db.prepare(`
      UPDATE cto_action_approvals SET status = 'expired'
      WHERE status IN ('pending', 'approved')
        AND (
          expires_at_ms <= ?
          OR owner_id IS NULL
          OR (
            status = 'pending' AND decision_capability_hash IS NULL
          )
          OR NOT EXISTS (
            SELECT 1 FROM cto_process_owners
            WHERE cto_process_owners.owner_id =
              cto_action_approvals.owner_id
              AND cto_process_owners.expires_at_ms > ?
          )
        )
    `).run(now, now);
  }
}
