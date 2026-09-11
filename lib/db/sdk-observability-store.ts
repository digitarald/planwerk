import type Database from "better-sqlite3";

export const SDK_OBSERVABILITY_EVENT_TYPES = [
  "assistant.turn_start",
  "assistant.turn_end",
  "assistant.message",
  "tool.execution_start",
  "tool.execution_complete",
  "permission.requested",
  "permission.completed",
  "session.error",
  "model.call_failure",
  "assistant.usage",
  "session.compaction_start",
  "session.compaction_complete",
  "assistant.idle",
  "session.idle",
] as const;

export type SdkObservabilityEventType =
  (typeof SDK_OBSERVABILITY_EVENT_TYPES)[number];

type MetadataValue = string | number | boolean | null;

export interface SdkObservabilityContext {
  sdkSessionId: string;
  boardId?: string;
  workspaceId?: string;
  cardId?: string;
  turnId?: string;
  toolCallId?: string;
  agentId?: string;
}

export interface StoredSdkObservabilityEvent {
  sdkEventId: string;
  sdkSessionId: string;
  eventType: SdkObservabilityEventType;
  parentEventId: string | null;
  timestamp: string;
  boardId: string | null;
  workspaceId: string | null;
  cardId: string | null;
  turnId: string | null;
  toolCallId: string | null;
  agentId: string | null;
  metadata: Record<string, MetadataValue>;
  ingestedAt: string;
}

export interface RecentSdkEventQuery {
  sdkSessionId?: string;
  cardId?: string;
  eventTypes?: SdkObservabilityEventType[];
  since?: string;
  before?: string;
  limit?: number;
}

export interface SdkUsageQuery {
  sdkSessionId?: string;
  cardId?: string;
  since?: string;
  before?: string;
}

export interface SdkModelUsage {
  model: string;
  requestCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  cost: number;
  totalNanoAiu: number;
  durationMs: number;
}

export interface SdkUsageAggregate extends Omit<SdkModelUsage, "model"> {
  models: SdkModelUsage[];
}

export type SdkEventIngestResult = "inserted" | "duplicate" | "ignored";

interface EventEnvelope {
  id: string;
  parentId: string | null;
  timestamp: string;
  type: SdkObservabilityEventType;
  agentId?: string;
  data: Record<string, unknown>;
}

interface NormalizedSdkEvent {
  sdkEventId: string;
  sdkSessionId: string;
  eventType: SdkObservabilityEventType;
  parentEventId: string | null;
  timestamp: string;
  boardId: string | null;
  workspaceId: string | null;
  cardId: string | null;
  turnId: string | null;
  toolCallId: string | null;
  agentId: string | null;
  metadata: Record<string, MetadataValue>;
}

const supportedEventTypes = new Set<string>(SDK_OBSERVABILITY_EVENT_TYPES);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function add(
  metadata: Record<string, MetadataValue>,
  key: string,
  value: MetadataValue | undefined
): void {
  if (value !== undefined) {
    metadata[key] = value;
  }
}

function readEnvelope(event: unknown): EventEnvelope | null {
  if (!isRecord(event)) return null;

  const type = asString(event.type);
  if (!type || !supportedEventTypes.has(type)) return null;

  const id = asString(event.id);
  const timestamp = asString(event.timestamp);
  const parentId = event.parentId === null ? null : asString(event.parentId);
  if (!id || !timestamp || parentId === undefined || !isRecord(event.data)) {
    return null;
  }

  return {
    id,
    timestamp,
    parentId,
    type: type as SdkObservabilityEventType,
    agentId: asString(event.agentId),
    data: event.data,
  };
}

function normalizePermissionRequest(
  data: Record<string, unknown>,
  metadata: Record<string, MetadataValue>
): void {
  const request = isRecord(data.permissionRequest)
    ? data.permissionRequest
    : undefined;
  add(metadata, "requestId", asString(data.requestId));
  add(metadata, "agentMode", asString(data.agentMode));
  add(metadata, "resolvedByHook", asBoolean(data.resolvedByHook));
  if (!request) return;

  const kind = asString(request.kind);
  add(metadata, "permissionKind", kind);
  add(metadata, "managedApprovalRequired", asBoolean(request.managedApprovalRequired));
  add(metadata, "requestSandboxBypass", asBoolean(request.requestSandboxBypass));

  if (kind === "mcp") {
    add(metadata, "serverName", asString(request.serverName));
    add(metadata, "toolName", asString(request.toolName));
    add(metadata, "readOnly", asBoolean(request.readOnly));
  } else if (kind === "custom-tool" || kind === "hook") {
    add(metadata, "toolName", asString(request.toolName));
    add(metadata, "skipPermission", asBoolean(request.skipPermission));
  } else if (kind === "extension-management") {
    add(metadata, "operation", asString(request.operation));
    add(metadata, "extensionName", asString(request.extensionName));
  } else if (kind === "factory") {
    add(metadata, "factoryName", asString(request.name));
    add(metadata, "operation", asString(request.operation));
    add(metadata, "maxAiCredits", asNumber(request.maxAiCredits));
    add(metadata, "maxConcurrentSubagents", asNumber(request.maxConcurrentSubagents));
    add(metadata, "maxTotalSubagents", asNumber(request.maxTotalSubagents));
    add(metadata, "timeoutSeconds", asNumber(request.timeoutSeconds));
  } else if (
    kind === "extension-permission-access" ||
    kind === "extension-env-access"
  ) {
    add(metadata, "extensionName", asString(request.extensionName));
  }
}

function normalizeMetadata(
  type: SdkObservabilityEventType,
  data: Record<string, unknown>
): Record<string, MetadataValue> {
  const metadata: Record<string, MetadataValue> = {};

  switch (type) {
    case "assistant.turn_start":
      add(metadata, "interactionId", asString(data.interactionId));
      add(metadata, "model", asString(data.model));
      break;
    case "assistant.turn_end":
      add(metadata, "model", asString(data.model));
      break;
    case "assistant.message": {
      add(metadata, "messageId", asString(data.messageId));
      add(metadata, "interactionId", asString(data.interactionId));
      add(metadata, "apiCallId", asString(data.apiCallId));
      add(metadata, "clientRequestId", asString(data.clientRequestId));
      add(metadata, "providerCallId", asString(data.requestId));
      add(metadata, "serviceRequestId", asString(data.serviceRequestId));
      add(metadata, "model", asString(data.model));
      add(metadata, "outputTokens", asNumber(data.outputTokens));
      add(metadata, "phase", asString(data.phase));
      add(metadata, "chunkIndex", asNumber(data.chunkIndex));
      add(metadata, "chunkCount", asNumber(data.chunkCount));
      add(metadata, "rte", asBoolean(data.rte));
      add(
        metadata,
        "toolRequestCount",
        Array.isArray(data.toolRequests) ? data.toolRequests.length : undefined
      );
      break;
    }
    case "tool.execution_start":
      add(metadata, "toolName", asString(data.toolName));
      add(metadata, "model", asString(data.model));
      add(metadata, "mcpServerName", asString(data.mcpServerName));
      add(metadata, "mcpToolName", asString(data.mcpToolName));
      add(metadata, "rte", asBoolean(data.rte));
      break;
    case "tool.execution_complete": {
      add(metadata, "success", asBoolean(data.success));
      add(metadata, "model", asString(data.model));
      add(metadata, "sandboxed", asBoolean(data.sandboxed));
      add(metadata, "isUserRequested", asBoolean(data.isUserRequested));
      add(metadata, "interactionId", asString(data.interactionId));
      add(metadata, "rte", asBoolean(data.rte));
      const error = isRecord(data.error) ? data.error : undefined;
      add(metadata, "errorCode", asString(error?.code));
      add(metadata, "remediation", asString(error?.remediation));
      break;
    }
    case "permission.requested":
      normalizePermissionRequest(data, metadata);
      break;
    case "permission.completed": {
      add(metadata, "requestId", asString(data.requestId));
      const result = isRecord(data.result) ? data.result : undefined;
      add(metadata, "resultKind", asString(result?.kind));
      add(
        metadata,
        "managedApprovalHandled",
        asBoolean(result?.managedApprovalHandled)
      );
      break;
    }
    case "session.error":
      add(metadata, "errorType", asString(data.errorType));
      add(metadata, "errorCode", asString(data.errorCode));
      add(metadata, "statusCode", asNumber(data.statusCode));
      add(metadata, "providerCallId", asString(data.providerCallId));
      add(metadata, "serviceRequestId", asString(data.serviceRequestId));
      add(metadata, "remediation", asString(data.remediation));
      add(metadata, "eligibleForAutoSwitch", asBoolean(data.eligibleForAutoSwitch));
      break;
    case "model.call_failure":
      add(metadata, "failureKind", asString(data.failureKind));
      add(metadata, "source", asString(data.source));
      add(metadata, "errorType", asString(data.errorType));
      add(metadata, "errorCode", asString(data.errorCode));
      add(metadata, "statusCode", asNumber(data.statusCode));
      add(metadata, "providerCallId", asString(data.providerCallId));
      add(metadata, "serviceRequestId", asString(data.serviceRequestId));
      add(metadata, "apiCallId", asString(data.apiCallId));
      add(metadata, "model", asString(data.model));
      add(metadata, "durationMs", asNumber(data.durationMs));
      add(metadata, "transport", asString(data.transport));
      add(metadata, "initiator", asString(data.initiator));
      add(metadata, "interactionType", asString(data.interactionType));
      add(metadata, "isAuto", asBoolean(data.isAuto));
      add(metadata, "isByok", asBoolean(data.isByok));
      break;
    case "assistant.usage": {
      const copilotUsage = isRecord(data.copilotUsage)
        ? data.copilotUsage
        : undefined;
      add(metadata, "model", asString(data.model));
      add(metadata, "inputTokens", asNumber(data.inputTokens));
      add(metadata, "outputTokens", asNumber(data.outputTokens));
      add(metadata, "cacheReadTokens", asNumber(data.cacheReadTokens));
      add(metadata, "cacheWriteTokens", asNumber(data.cacheWriteTokens));
      add(metadata, "reasoningTokens", asNumber(data.reasoningTokens));
      add(metadata, "cost", asNumber(data.cost));
      add(metadata, "totalNanoAiu", asNumber(copilotUsage?.totalNanoAiu));
      add(metadata, "durationMs", asNumber(data.duration));
      add(metadata, "timeToFirstTokenMs", asNumber(data.timeToFirstTokenMs));
      add(metadata, "outputTtftMs", asNumber(data.outputTtftMs));
      add(metadata, "interTokenLatencyMs", asNumber(data.interTokenLatencyMs));
      add(metadata, "providerCallId", asString(data.providerCallId));
      add(metadata, "serviceRequestId", asString(data.serviceRequestId));
      add(metadata, "apiCallId", asString(data.apiCallId));
      add(metadata, "apiEndpoint", asString(data.apiEndpoint));
      add(metadata, "transport", asString(data.transport));
      add(metadata, "finishReason", asString(data.finishReason));
      add(metadata, "initiator", asString(data.initiator));
      add(metadata, "interactionType", asString(data.interactionType));
      add(metadata, "isAuto", asBoolean(data.isAuto));
      add(metadata, "isByok", asBoolean(data.isByok));
      add(
        metadata,
        "contentFilterTriggered",
        asBoolean(data.contentFilterTriggered)
      );
      break;
    }
    case "session.compaction_start":
      add(metadata, "model", asString(data.model));
      add(metadata, "trigger", asString(data.trigger));
      add(metadata, "currentTokens", asNumber(data.currentTokens));
      add(metadata, "conversationTokens", asNumber(data.conversationTokens));
      add(metadata, "systemTokens", asNumber(data.systemTokens));
      add(metadata, "toolDefinitionsTokens", asNumber(data.toolDefinitionsTokens));
      add(metadata, "tokenLimit", asNumber(data.tokenLimit));
      break;
    case "session.compaction_complete": {
      add(metadata, "success", asBoolean(data.success));
      add(metadata, "trigger", asString(data.trigger));
      add(metadata, "messagesRemoved", asNumber(data.messagesRemoved));
      add(metadata, "preCompactionTokens", asNumber(data.preCompactionTokens));
      add(metadata, "postCompactionTokens", asNumber(data.postCompactionTokens));
      add(metadata, "tokensRemoved", asNumber(data.tokensRemoved));
      add(metadata, "tokenLimit", asNumber(data.tokenLimit));
      add(metadata, "checkpointNumber", asNumber(data.checkpointNumber));
      add(metadata, "statusCode", asNumber(data.statusCode));
      add(metadata, "providerCallId", asString(data.requestId));
      add(metadata, "serviceRequestId", asString(data.serviceRequestId));
      const usage = isRecord(data.compactionTokensUsed)
        ? data.compactionTokensUsed
        : undefined;
      add(metadata, "model", asString(usage?.model));
      add(metadata, "inputTokens", asNumber(usage?.inputTokens));
      add(metadata, "outputTokens", asNumber(usage?.outputTokens));
      add(metadata, "cacheReadTokens", asNumber(usage?.cacheReadTokens));
      add(metadata, "cacheWriteTokens", asNumber(usage?.cacheWriteTokens));
      add(metadata, "durationMs", asNumber(usage?.duration));
      break;
    }
    case "assistant.idle":
      add(metadata, "aborted", asBoolean(data.aborted));
      break;
    case "session.idle":
      add(metadata, "aborted", asBoolean(data.aborted));
      add(metadata, "mode", asString(data.mode));
      break;
  }

  return metadata;
}

function normalizeEvent(
  event: unknown,
  context: SdkObservabilityContext
): NormalizedSdkEvent | null {
  if (!context.sdkSessionId) return null;
  const envelope = readEnvelope(event);
  if (!envelope) return null;

  const turnId = asString(envelope.data.turnId) ?? context.turnId ?? null;
  const permissionRequest = isRecord(envelope.data.permissionRequest)
    ? envelope.data.permissionRequest
    : undefined;
  const toolCallId =
    asString(envelope.data.toolCallId) ??
    asString(permissionRequest?.toolCallId) ??
    context.toolCallId ??
    null;

  return {
    sdkEventId: envelope.id,
    sdkSessionId: context.sdkSessionId,
    eventType: envelope.type,
    parentEventId: envelope.parentId,
    timestamp: envelope.timestamp,
    boardId: context.boardId ?? null,
    workspaceId: context.workspaceId ?? null,
    cardId: context.cardId ?? null,
    turnId,
    toolCallId,
    agentId: envelope.agentId ?? context.agentId ?? null,
    metadata: normalizeMetadata(envelope.type, envelope.data),
  };
}

interface StoredRow {
  sdk_event_id: string;
  sdk_session_id: string;
  event_type: SdkObservabilityEventType;
  parent_event_id: string | null;
  event_timestamp: string;
  board_id: string | null;
  workspace_id: string | null;
  card_id: string | null;
  turn_id: string | null;
  tool_call_id: string | null;
  agent_id: string | null;
  metadata_json: string;
  ingested_at: string;
}

interface UsageRow {
  model?: string;
  request_count: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  reasoning_tokens: number;
  cost: number;
  total_nano_aiu: number;
  duration_ms: number;
}

function mapUsageRow(row: UsageRow, model?: string): SdkModelUsage {
  return {
    model: model ?? row.model ?? "unknown",
    requestCount: row.request_count,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    cacheReadTokens: row.cache_read_tokens,
    cacheWriteTokens: row.cache_write_tokens,
    reasoningTokens: row.reasoning_tokens,
    cost: row.cost,
    totalNanoAiu: row.total_nano_aiu,
    durationMs: row.duration_ms,
  };
}

function usageSelect(): string {
  return `
    COUNT(*) AS request_count,
    COALESCE(SUM(CAST(json_extract(metadata_json, '$.inputTokens') AS INTEGER)), 0) AS input_tokens,
    COALESCE(SUM(CAST(json_extract(metadata_json, '$.outputTokens') AS INTEGER)), 0) AS output_tokens,
    COALESCE(SUM(CAST(json_extract(metadata_json, '$.cacheReadTokens') AS INTEGER)), 0) AS cache_read_tokens,
    COALESCE(SUM(CAST(json_extract(metadata_json, '$.cacheWriteTokens') AS INTEGER)), 0) AS cache_write_tokens,
    COALESCE(SUM(CAST(json_extract(metadata_json, '$.reasoningTokens') AS INTEGER)), 0) AS reasoning_tokens,
    COALESCE(SUM(CAST(json_extract(metadata_json, '$.cost') AS REAL)), 0) AS cost,
    COALESCE(SUM(CAST(json_extract(metadata_json, '$.totalNanoAiu') AS INTEGER)), 0) AS total_nano_aiu,
    COALESCE(SUM(CAST(json_extract(metadata_json, '$.durationMs') AS INTEGER)), 0) AS duration_ms
  `;
}

export class SdkObservabilityStore {
  private readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  ingest(
    event: unknown,
    context: SdkObservabilityContext
  ): SdkEventIngestResult {
    const normalized = normalizeEvent(event, context);
    if (!normalized) return "ignored";

    const result = this.db
      .prepare(`
        INSERT INTO sdk_observability_events (
          sdk_event_id, sdk_session_id, event_type, parent_event_id,
          event_timestamp, board_id, workspace_id, card_id, turn_id,
          tool_call_id, agent_id, metadata_json, ingested_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(sdk_event_id) DO NOTHING
      `)
      .run(
        normalized.sdkEventId,
        normalized.sdkSessionId,
        normalized.eventType,
        normalized.parentEventId,
        normalized.timestamp,
        normalized.boardId,
        normalized.workspaceId,
        normalized.cardId,
        normalized.turnId,
        normalized.toolCallId,
        normalized.agentId,
        JSON.stringify(normalized.metadata)
      );

    return result.changes === 1 ? "inserted" : "duplicate";
  }

  recent(query: RecentSdkEventQuery = {}): StoredSdkObservabilityEvent[] {
    if (query.eventTypes?.length === 0) return [];

    const conditions: string[] = [];
    const parameters: Array<string | number> = [];
    if (query.sdkSessionId) {
      conditions.push("sdk_session_id = ?");
      parameters.push(query.sdkSessionId);
    }
    if (query.cardId) {
      conditions.push("card_id = ?");
      parameters.push(query.cardId);
    }
    if (query.since) {
      conditions.push("event_timestamp >= ?");
      parameters.push(query.since);
    }
    if (query.before) {
      conditions.push("event_timestamp < ?");
      parameters.push(query.before);
    }
    if (query.eventTypes) {
      conditions.push(
        `event_type IN (${query.eventTypes.map(() => "?").join(", ")})`
      );
      parameters.push(...query.eventTypes);
    }

    const limit = Math.min(Math.max(query.limit ?? 100, 1), 500);
    parameters.push(limit);
    const where = conditions.length > 0
      ? `WHERE ${conditions.join(" AND ")}`
      : "";
    const rows = this.db
      .prepare(`
        SELECT sdk_event_id, sdk_session_id, event_type, parent_event_id,
               event_timestamp, board_id, workspace_id, card_id, turn_id,
               tool_call_id, agent_id,
               metadata_json, ingested_at
        FROM sdk_observability_events
        ${where}
        ORDER BY event_timestamp DESC, rowid DESC
        LIMIT ?
      `)
      .all(...parameters) as StoredRow[];

    return rows.map((row) => ({
      sdkEventId: row.sdk_event_id,
      sdkSessionId: row.sdk_session_id,
      eventType: row.event_type,
      parentEventId: row.parent_event_id,
      timestamp: row.event_timestamp,
      boardId: row.board_id,
      workspaceId: row.workspace_id,
      cardId: row.card_id,
      turnId: row.turn_id,
      toolCallId: row.tool_call_id,
      agentId: row.agent_id,
      metadata: JSON.parse(row.metadata_json) as Record<string, MetadataValue>,
      ingestedAt: row.ingested_at,
    }));
  }

  aggregateUsage(query: SdkUsageQuery = {}): SdkUsageAggregate {
    const conditions = ["event_type = 'assistant.usage'"];
    const parameters: string[] = [];
    if (query.sdkSessionId) {
      conditions.push("sdk_session_id = ?");
      parameters.push(query.sdkSessionId);
    }
    if (query.cardId) {
      conditions.push("card_id = ?");
      parameters.push(query.cardId);
    }
    if (query.since) {
      conditions.push("event_timestamp >= ?");
      parameters.push(query.since);
    }
    if (query.before) {
      conditions.push("event_timestamp < ?");
      parameters.push(query.before);
    }
    const where = `WHERE ${conditions.join(" AND ")}`;

    const total = this.db
      .prepare(`
        SELECT ${usageSelect()}
        FROM sdk_observability_events
        ${where}
      `)
      .get(...parameters) as UsageRow;
    const modelRows = this.db
      .prepare(`
        SELECT COALESCE(json_extract(metadata_json, '$.model'), 'unknown') AS model,
               ${usageSelect()}
        FROM sdk_observability_events
        ${where}
        GROUP BY COALESCE(json_extract(metadata_json, '$.model'), 'unknown')
        ORDER BY total_nano_aiu DESC, model ASC
      `)
      .all(...parameters) as UsageRow[];

    const aggregate = mapUsageRow(total);
    return {
      requestCount: aggregate.requestCount,
      inputTokens: aggregate.inputTokens,
      outputTokens: aggregate.outputTokens,
      cacheReadTokens: aggregate.cacheReadTokens,
      cacheWriteTokens: aggregate.cacheWriteTokens,
      reasoningTokens: aggregate.reasoningTokens,
      cost: aggregate.cost,
      totalNanoAiu: aggregate.totalNanoAiu,
      durationMs: aggregate.durationMs,
      models: modelRows.map((row) => mapUsageRow(row)),
    };
  }
}
