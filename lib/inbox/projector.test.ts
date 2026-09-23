import assert from "node:assert/strict";
import test from "node:test";

import type { KanbanCard } from "../types.ts";
import {
  projectArchivedSession,
  projectCardSnapshot,
  projectExistingCompletionRefresh,
  projectHeartbeatAction,
  projectRemovedSession,
} from "./projector.ts";

function card(overrides: Partial<KanbanCard> = {}): KanbanCard {
  return {
    id: "card-1",
    title: "Research task",
    phase: "build",
    runtime: "running",
    gateStatus: "pending",
    attention: "none",
    risk: "low",
    activity: "Researching API behavior",
    additions: 0,
    deletions: 0,
    filesChanged: 0,
    planSteps: { total: 0, done: 0 },
    modifiedAt: Date.parse("2026-09-22T00:00:00.000Z"),
    ...overrides,
  };
}

const context = {
  hostUrl: "ws://127.0.0.1:9000",
  now: "2026-09-22T00:10:00.000Z",
};

test("pending-input projection replaces stale requests and later resolves", () => {
  const pending = card({
    runtime: "input-needed",
    pendingInput: {
      requestId: "request-2",
      message: "Choose the deployment target.",
      questions: [
        {
          id: "target",
          kind: "single-select",
          message: "Which target?",
          options: [{ id: "test", label: "Test" }],
        },
      ],
    },
  });
  const operations = projectCardSnapshot(pending, card(), context);
  assert.deepEqual(
    operations.slice(0, 2).map((operation) => operation.type),
    ["resolve-kind", "upsert"],
  );
  const pendingUpsert = operations.find(
    (operation) =>
      operation.type === "upsert" && operation.item.kind === "pending-input",
  );
  assert.equal(
    pendingUpsert?.type === "upsert"
      ? pendingUpsert.item.sourceKey
      : undefined,
    "session:card-1:pending-input:request-2",
  );

  const cleared = projectCardSnapshot(
    card({ runtime: "running" }),
    pending,
    context,
  );
  assert.deepEqual(cleared[0], {
    type: "resolve-kind",
    kind: "pending-input",
    cardId: "card-1",
  });
});

test("idle transition creates a meaningful no-code completion briefing", () => {
  const operations = projectCardSnapshot(
    card({
      runtime: "idle",
      artifacts: [{
        id: "research-1",
        type: "research",
        title: "API findings",
        createdAt: Date.parse("2026-09-22T00:05:00.000Z"),
        createdBy: "agent",
        status: "draft",
      }],
    }),
    card({ runtime: "running" }),
    context,
  );
  const completion = operations.find(
    (operation) =>
      operation.type === "upsert" && operation.item.kind === "completion",
  );
  assert.ok(completion && completion.type === "upsert");
  assert.match(completion.item.briefing.outcome, /research output/);
  assert.ok(
    completion.item.briefing.caveats.some((caveat) =>
      caveat.includes("No code changes")
    ),
  );
});

test("a resumed session retracts its completion", () => {
  const operations = projectCardSnapshot(
    card({ runtime: "running" }),
    card({ runtime: "idle" }),
    context,
  );
  assert.ok(operations.some(
    (operation) =>
      operation.type === "resolve-kind" &&
      operation.kind === "completion" &&
      operation.cardId === "card-1",
  ));
});

test("final agent context refreshes an idle completion", () => {
  const operations = projectCardSnapshot(
    card({
      runtime: "idle",
      activity: "Finished",
      filesChanged: 50,
      lastAgentMessage:
        "Implemented and dogfooded the inbox/feed experience end to end.\n\n### What changed\n\n- Removed stale items.",
    }),
    card({
      runtime: "idle",
      activity: "Finished",
      filesChanged: 50,
    }),
    context,
  );
  const completion = operations.find(
    (operation) =>
      operation.type === "upsert" && operation.item.kind === "completion",
  );
  assert.ok(completion && completion.type === "upsert");
  assert.equal(
    completion.item.briefing.reason,
    "Implemented and dogfooded the inbox/feed experience end to end.",
  );
  assert.equal(completion.item.briefing.outcome, "The session produced 50 changed files.");
});

test("existing completion refresh uses cached final agent context", () => {
  const operations = projectExistingCompletionRefresh(
    card({
      runtime: "idle",
      filesChanged: 24,
      lastAgentMessage:
        "**Task completed:** Implemented the `COPILOT_TOKEN` migration.\n\n### Validation\n\nAll checks passed.",
    }),
    context,
  );
  const completion = operations.find(
    (operation) =>
      operation.type === "upsert" && operation.item.kind === "completion",
  );
  assert.ok(completion && completion.type === "upsert");
  assert.equal(
    completion.item.briefing.reason,
    "Task completed: Implemented the COPILOT_TOKEN migration.",
  );
});

test("completion identity ignores modifiedAt-only churn", () => {
  const first = projectExistingCompletionRefresh(card({
    runtime: "idle",
    lastAgentMessage: "The implementation is ready for review.",
  }), context);
  const later = projectExistingCompletionRefresh(card({
    runtime: "idle",
    lastAgentMessage: "The implementation is ready for review.",
    modifiedAt: Date.parse("2026-09-22T00:30:00.000Z"),
  }), context);
  const firstItem = first[1]?.type === "upsert" ? first[1].item : undefined;
  const laterItem = later[1]?.type === "upsert" ? later[1].item : undefined;
  assert.equal(firstItem?.sourceKey, laterItem?.sourceKey);
  assert.equal(firstItem?.sourceRevision, laterItem?.sourceRevision);
});

test("runtime errors and readiness resolve without moving board state", () => {
  const errorOperations = projectCardSnapshot(
    card({ runtime: "error", phase: "review" }),
    card({ runtime: "running" }),
    context,
  );
  assert.ok(errorOperations.some(
    (operation) =>
      operation.type === "upsert" &&
      operation.item.kind === "runtime-error",
  ));
  assert.ok(errorOperations.some(
    (operation) =>
      operation.type === "upsert" &&
      operation.item.kind === "review-ready",
  ));

  const recovered = projectCardSnapshot(
    card({ runtime: "idle", phase: "review" }),
    card({ runtime: "error", phase: "review" }),
    context,
  );
  assert.ok(recovered.some(
    (operation) =>
      operation.type === "resolve-source" &&
      operation.sourceKey === "session:card-1:runtime-error",
  ));
  assert.equal(card().phase, "build");
});

test("initial snapshots do not replay historical readiness or completion", () => {
  const operations = projectCardSnapshot(
    card({
      phase: "ship",
      runtime: "idle",
      isArchived: true,
      filesChanged: 3,
    }),
    undefined,
    context,
  );
  assert.equal(
    operations.some((operation) => operation.type === "upsert"),
    false,
  );

  const running = projectCardSnapshot(card({ runtime: "running" }), undefined, context);
  assert.ok(running.some(
    (operation) =>
      operation.type === "resolve-kind" &&
      operation.kind === "completion",
  ));
});

test("heartbeat failures, conflicts, and clears use stable source keys", () => {
  const failed = projectHeartbeatAction({
    type: "gate-completed",
    cardId: "card-1",
    gateType: "test",
    status: "failed",
  }, card(), context);
  assert.equal(
    failed[0].type === "upsert" ? failed[0].item.sourceKey : undefined,
    "card:card-1:gate-failure:test",
  );

  const passed = projectHeartbeatAction({
    type: "gate-completed",
    cardId: "card-1",
    gateType: "test",
    status: "passed",
  }, card(), context);
  assert.deepEqual(passed, [{
    type: "resolve-source",
    sourceKey: "card:card-1:gate-failure:test",
  }]);

  const conflict = projectHeartbeatAction({
    type: "coherence-conflict",
    cardId: "card-z",
    otherCardId: "card-a",
    summary: "Both cards edit the same module.",
  }, undefined, context);
  assert.equal(
    conflict[0].type === "upsert" ? conflict[0].item.sourceKey : undefined,
    "coherence:card-a:card-z",
  );
  const cleared = projectHeartbeatAction({
    type: "coherence-cleared",
    cardId: "card-z",
    otherCardId: "card-a",
  }, undefined, context);
  assert.deepEqual(cleared, [{
    type: "resolve-source",
    sourceKey: "coherence:card-a:card-z",
  }]);

  assert.deepEqual(projectHeartbeatAction({
    type: "source-revision-required",
    cardId: "card-1",
    reason: "Current enrichment is unavailable.",
  }, card(), context), []);

  assert.deepEqual(projectHeartbeatAction({
    type: "wip-cleared",
    phase: "build",
  }, undefined, context), [{
    type: "resolve-source",
    sourceKey: "orchestrator:wip:build",
  }]);

  assert.deepEqual(projectHeartbeatAction({
    type: "wip-violation",
    phase: "build",
    count: 9,
    limit: 3,
  }, undefined, context), [{
    type: "resolve-source",
    sourceKey: "orchestrator:wip:build",
  }]);
});

test("archived no-code sessions still produce completion", () => {
  const operations = projectArchivedSession({
    resource: "session-1",
    provider: "copilot",
    title: "Research only",
    status: 64,
    activity: "Summarized findings",
    createdAt: "2026-09-22T00:00:00.000Z",
    modifiedAt: "2026-09-22T00:10:00.000Z",
    changes: { additions: 0, deletions: 0, files: 0 },
  }, context);
  assert.ok(operations.some(
    (operation) =>
      operation.type === "upsert" &&
      operation.item.kind === "completion" &&
      operation.item.briefing.outcome.includes("without detected code changes"),
  ));
  assert.ok(operations.some(
    (operation) =>
      operation.type === "resolve-kind" &&
      operation.kind === "pending-input",
  ));
});

test("removed sessions clear ephemeral briefings without creating completion", () => {
  const operations = projectRemovedSession("card-1");
  assert.deepEqual(operations, [
    { type: "resolve-kind", kind: "pending-input", cardId: "card-1" },
    {
      type: "resolve-source",
      sourceKey: "session:card-1:runtime-error",
    },
    {
      type: "resolve-source",
      sourceKey: "card:card-1:ready:review",
    },
    {
      type: "resolve-source",
      sourceKey: "card:card-1:ready:ship",
    },
  ]);
});
