import assert from "node:assert/strict";
import { test } from "node:test";
import Database from "better-sqlite3";

import { ensureSdkObservabilitySchema } from "./sdk-observability-schema.ts";
import {
  SDK_OBSERVABILITY_EVENT_TYPES,
  SdkObservabilityStore,
} from "./sdk-observability-store.ts";

function createStore(): {
  db: Database.Database;
  store: SdkObservabilityStore;
} {
  const db = new Database(":memory:");
  ensureSdkObservabilitySchema(db);
  return { db, store: new SdkObservabilityStore(db) };
}

function event(
  id: string,
  type: string,
  data: Record<string, unknown>,
  options: { timestamp?: string; parentId?: string | null; agentId?: string } = {}
) {
  return {
    id,
    type,
    data,
    parentId: options.parentId ?? null,
    timestamp: options.timestamp ?? "2026-09-10T20:00:00.000Z",
    agentId: options.agentId,
  };
}

test("schema initialization is restart-safe and migrates additive columns", () => {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE sdk_observability_events (
      sdk_event_id TEXT PRIMARY KEY,
      sdk_session_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      parent_event_id TEXT,
      event_timestamp TEXT NOT NULL
    );
    INSERT INTO sdk_observability_events (
      sdk_event_id, sdk_session_id, event_type, parent_event_id, event_timestamp
    ) VALUES ('existing', 'session-1', 'assistant.turn_start', NULL, '2026-09-10T19:00:00Z');
  `);

  ensureSdkObservabilitySchema(db);
  ensureSdkObservabilitySchema(db);

  const columns = db
    .prepare("PRAGMA table_info(sdk_observability_events)")
    .all() as Array<{ name: string }>;
  assert.deepEqual(
    [
      "board_id",
      "workspace_id",
      "card_id",
      "turn_id",
      "tool_call_id",
      "agent_id",
      "metadata_json",
      "ingested_at",
    ]
      .every((name) => columns.some((column) => column.name === name)),
    true
  );
  assert.deepEqual(
    db.prepare(`
      SELECT metadata_json, ingested_at IS NOT NULL AS has_ingested_at
      FROM sdk_observability_events WHERE sdk_event_id = 'existing'
    `).get(),
    { metadata_json: "{}", has_ingested_at: 1 }
  );
  const store = new SdkObservabilityStore(db);
  assert.equal(
    store.ingest(
      event("after-migration", "session.idle", {}),
      { sdkSessionId: "session-1" }
    ),
    "inserted"
  );
  assert.equal(
    (db.prepare(`
      SELECT ingested_at IS NOT NULL AS has_ingested_at
      FROM sdk_observability_events WHERE sdk_event_id = 'after-migration'
    `).get() as { has_ingested_at: number }).has_ingested_at,
    1
  );

  db.close();
});

test("ingestion is selective, idempotent, and preserves correlation", () => {
  const { db, store } = createStore();
  const context = {
    sdkSessionId: "session-1",
    boardId: "board-1",
    workspaceId: "/workspace",
    cardId: "card-1",
  };
  const start = event(
    "event-1",
    "assistant.turn_start",
    { turnId: "turn-1", interactionId: "interaction-1", model: "gpt-5" },
    { parentId: "event-0", agentId: "agent-1" }
  );

  assert.equal(store.ingest(start, context), "inserted");
  assert.equal(store.ingest(start, context), "duplicate");
  assert.equal(
    store.ingest(
      event("future-1", "assistant.some_future_event", { content: "do not store" }),
      context
    ),
    "ignored"
  );
  assert.equal(
    store.ingest(
      event("delta-1", "assistant.message_delta", { deltaContent: "secret" }),
      context
    ),
    "ignored"
  );

  const [stored] = store.recent({ sdkSessionId: "session-1" });
  assert.deepEqual(stored, {
    sdkEventId: "event-1",
    sdkSessionId: "session-1",
    eventType: "assistant.turn_start",
    parentEventId: "event-0",
    timestamp: "2026-09-10T20:00:00.000Z",
    boardId: "board-1",
    workspaceId: "/workspace",
    cardId: "card-1",
    turnId: "turn-1",
    toolCallId: null,
    agentId: "agent-1",
    metadata: { interactionId: "interaction-1", model: "gpt-5" },
    ingestedAt: stored.ingestedAt,
  });
  const count = db
    .prepare("SELECT COUNT(*) AS count FROM sdk_observability_events")
    .get() as { count: number };
  assert.equal(count.count, 1);
  db.close();
});

test("normalization never stores content, prompts, arguments, results, or credentials", () => {
  const { db, store } = createStore();
  const context = { sdkSessionId: "session-private", cardId: "card-private" };
  const sensitive = "SENSITIVE-MARKER";

  const events = [
    event("message", "assistant.message", {
      messageId: "message-1",
      turnId: "turn-1",
      model: "claude",
      content: sensitive,
      reasoningText: sensitive,
      encryptedContent: sensitive,
      toolRequests: [{ name: "view", arguments: { secret: sensitive } }],
    }),
    event("tool-start", "tool.execution_start", {
      toolCallId: "tool-1",
      turnId: "turn-1",
      toolName: "shell",
      arguments: { command: sensitive },
      shellToolInfo: { displayCommand: sensitive, possiblePaths: [sensitive] },
    }),
    event("tool-complete", "tool.execution_complete", {
      toolCallId: "tool-1",
      turnId: "turn-1",
      success: false,
      result: { content: sensitive, detailedContent: sensitive },
      error: { code: "FAILED", message: sensitive, remediation: "review_sandbox_policy" },
      toolTelemetry: { arbitrary: sensitive },
    }),
    event("permission-request", "permission.requested", {
      requestId: "permission-1",
      permissionRequest: {
        kind: "shell",
        toolCallId: "tool-1",
        fullCommandText: sensitive,
        intention: sensitive,
        possiblePaths: [sensitive],
        possibleUrls: [{ url: sensitive }],
      },
      promptRequest: { fullCommandText: sensitive },
      riskAssessment: { detail: sensitive },
    }),
    event("permission-complete", "permission.completed", {
      requestId: "permission-1",
      toolCallId: "tool-1",
      result: { kind: "denied-interactively-by-user", feedback: sensitive },
    }),
    event("session-error", "session.error", {
      errorType: "authentication",
      errorCode: "AUTH",
      message: sensitive,
      stack: sensitive,
      remediation: "sign_in",
      providerCallId: "provider-request-1",
    }),
    event("model-error", "model.call_failure", {
      source: "top_level",
      model: "gpt-5",
      failureKind: "api",
      errorCode: "bad_request",
      errorMessage: sensitive,
      providerCallId: "provider-request-2",
    }),
    event("compaction", "session.compaction_complete", {
      success: false,
      error: sensitive,
      summaryContent: sensitive,
      customInstructions: sensitive,
      requestId: "provider-request-3",
    }),
  ];

  for (const sdkEvent of events) {
    assert.equal(store.ingest(sdkEvent, context), "inserted");
  }

  const rows = db
    .prepare("SELECT metadata_json FROM sdk_observability_events")
    .all() as Array<{ metadata_json: string }>;
  assert.equal(JSON.stringify(rows).includes(sensitive), false);

  const stored = store.recent({ sdkSessionId: "session-private", limit: 20 });
  assert.equal(stored.find((item) => item.sdkEventId === "message")?.metadata.toolRequestCount, 1);
  assert.deepEqual(
    stored.find((item) => item.sdkEventId === "tool-complete")?.metadata,
    { success: false, errorCode: "FAILED", remediation: "review_sandbox_policy" }
  );
  assert.deepEqual(
    stored.find((item) => item.sdkEventId === "session-error")?.metadata,
    {
      errorType: "authentication",
      errorCode: "AUTH",
      providerCallId: "provider-request-1",
      remediation: "sign_in",
    }
  );
  db.close();
});

test("all supported lifecycle categories ingest without retaining arbitrary payloads", () => {
  const { db, store } = createStore();
  const context = {
    sdkSessionId: "session-all",
    turnId: "fallback-turn",
    toolCallId: "fallback-tool",
  };

  for (const [index, type] of SDK_OBSERVABILITY_EVENT_TYPES.entries()) {
    assert.equal(
      store.ingest(
        event(`event-${index}`, type, {
          turnId: "turn-1",
          toolCallId: "tool-1",
          arbitraryFutureField: "not persisted",
        }),
        context
      ),
      "inserted"
    );
  }

  assert.equal(store.recent({ limit: 100 }).length, SDK_OBSERVABILITY_EVENT_TYPES.length);
  const metadata = db
    .prepare("SELECT metadata_json FROM sdk_observability_events")
    .all() as Array<{ metadata_json: string }>;
  assert.equal(JSON.stringify(metadata).includes("arbitraryFutureField"), false);
  db.close();
});

test("recent queries filter events and usage aggregates by model", () => {
  const { db, store } = createStore();
  const context = { sdkSessionId: "session-usage", cardId: "card-usage" };
  const otherContext = { sdkSessionId: "other-session", cardId: "other-card" };

  assert.equal(
    store.ingest(
      event(
        "usage-1",
        "assistant.usage",
        {
          model: "gpt-5",
          inputTokens: 100,
          outputTokens: 20,
          cacheReadTokens: 30,
          cacheWriteTokens: 5,
          reasoningTokens: 7,
          cost: 1.5,
          duration: 400,
          copilotUsage: { totalNanoAiu: 2_000 },
        },
        { timestamp: "2026-09-10T20:01:00.000Z" }
      ),
      context
    ),
    "inserted"
  );
  assert.equal(
    store.ingest(
      event(
        "usage-2",
        "assistant.usage",
        {
          model: "claude",
          inputTokens: 40,
          outputTokens: 10,
          cost: 2,
          duration: 250,
          copilotUsage: { totalNanoAiu: 4_000 },
        },
        { timestamp: "2026-09-10T20:02:00.000Z" }
      ),
      context
    ),
    "inserted"
  );
  store.ingest(
    event(
      "usage-other",
      "assistant.usage",
      {
        model: "gpt-5",
        inputTokens: 999,
        copilotUsage: { totalNanoAiu: 999_000 },
      },
      { timestamp: "2026-09-10T20:03:00.000Z" }
    ),
    otherContext
  );
  store.ingest(
    event(
      "idle",
      "session.idle",
      { aborted: false, mode: "autopilot" },
      { timestamp: "2026-09-10T20:04:00.000Z" }
    ),
    context
  );

  assert.deepEqual(
    store.recent({
      cardId: "card-usage",
      eventTypes: ["assistant.usage"],
      limit: 1,
    }).map((item) => item.sdkEventId),
    ["usage-2"]
  );
  assert.deepEqual(store.recent({ eventTypes: [] }), []);

  assert.deepEqual(store.aggregateUsage({ sdkSessionId: "session-usage" }), {
    requestCount: 2,
    inputTokens: 140,
    outputTokens: 30,
    cacheReadTokens: 30,
    cacheWriteTokens: 5,
    reasoningTokens: 7,
    cost: 3.5,
    totalNanoAiu: 6_000,
    durationMs: 650,
    models: [
      {
        model: "claude",
        requestCount: 1,
        inputTokens: 40,
        outputTokens: 10,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        cost: 2,
        totalNanoAiu: 4_000,
        durationMs: 250,
      },
      {
        model: "gpt-5",
        requestCount: 1,
        inputTokens: 100,
        outputTokens: 20,
        cacheReadTokens: 30,
        cacheWriteTokens: 5,
        reasoningTokens: 7,
        cost: 1.5,
        totalNanoAiu: 2_000,
        durationMs: 400,
      },
    ],
  });
  db.close();
});
