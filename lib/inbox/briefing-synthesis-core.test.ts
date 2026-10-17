import assert from "node:assert/strict";
import test from "node:test";

import type { InboxItem } from "./types.ts";
import {
  applySynthesizedBriefing,
  briefingSynthesisSystemPrompt,
  briefingResponseSchema,
  buildBriefingSynthesisPrompt,
  canApplySynthesizedBriefing,
  normalizeSynthesizedBriefing,
  synthesisRequestId,
  type InboxSynthesisEvidence,
} from "./briefing-synthesis-core.ts";

const evidence: InboxSynthesisEvidence = {
  taskTitle: "KOWC Slides finished",
  kind: "completion",
  eventType: "session-idle",
  sourceRevision: "source-1",
  currentBriefing: {
    reason: "Task completed: No. The earlier human review bucket was too broad.",
    recommendation: "",
    outcome: "The session produced 12 changed files.",
    caveats: ["Completion does not imply that external gates passed."],
  },
  session: {
    phase: "review",
    runtime: "idle",
    gateStatus: "passed",
    finalResponse:
      "The remaining pull-request queue is empty. I reviewed every item and all workflow checks passed.",
  },
};

function item(): InboxItem {
  return {
    id: "item-1",
    sourceKey: "host:local:session:card-1:completion:source-1",
    sourceRevision: "source-1",
    kind: "completion",
    priorityBand: "normal",
    priorityRank: 190,
    workflowState: "open",
    readState: "read",
    cardId: "card-1",
    relatedCardIds: [],
    title: evidence.taskTitle,
    briefing: {
      message: evidence.currentBriefing.reason,
      recommendation: "",
      reason: evidence.currentBriefing.reason,
      alternativeActions: [],
      outcome: evidence.currentBriefing.outcome,
      caveats: evidence.currentBriefing.caveats,
      confidence: "high",
      synthesis: {
        status: "pending",
        requestId: synthesisRequestId(evidence),
      },
      freshness: { observedAt: "2026-09-22T00:00:00.000Z" },
      provenance: {
        sourceType: "ahp-session",
        sourceKey: "host:local:session:card-1:completion:source-1",
        eventType: "session-idle",
        cardId: "card-1",
        sourceRevision: "source-1",
      },
    },
    createdAt: "2026-09-22T00:00:00.000Z",
    updatedAt: "2026-09-22T00:00:00.000Z",
    readAt: "2026-09-22T00:01:00.000Z",
    resolvedAt: null,
    pinnedAt: null,
    snoozedUntil: null,
  };
}

test("briefing prompt asks for an authored note rather than a prose template", () => {
  const prompt = briefingSynthesisSystemPrompt();
  assert.match(prompt, /exact inbox note/i);
  assert.match(prompt, /Do not fill in a template/i);
  assert.match(prompt, /whichever is most useful/i);
  assert.match(prompt, /Use only facts present/i);
  assert.match(prompt, /Preserve user-relevant technical identifiers exactly/i);
  assert.match(prompt, /Omit internal source revisions/i);
});

test("authoring prompt omits internal routing metadata", () => {
  const prompt = buildBriefingSynthesisPrompt({
    ...evidence,
    event: {
      type: "wip-violation",
      sourceRevision: "private-revision",
      cardId: "internal-card",
      reason: "Build has too many active cards.",
    },
  });
  assert.doesNotMatch(prompt, /private-revision|internal-card|sourceRevision/);
  assert.match(prompt, /Build has too many active cards/);
});

test("parses free briefing prose with executable action metadata", () => {
  const parsed = normalizeSynthesizedBriefing({
    headline: "The PR queue is clear",
    message:
      "Every remaining PR has been reviewed and the workflow checks passed. Nothing needs your attention unless you want to inspect the final queue.",
    attention: "routine",
    primaryAction: { intent: "resolve", label: "Clear" },
    secondaryActions: [{ intent: "open-session", label: "See result" }],
  }, "completion");

  assert.deepEqual(parsed, {
    headline: "The PR queue is clear",
    message:
      "Every remaining PR has been reviewed and the workflow checks passed. Nothing needs your attention unless you want to inspect the final queue.",
    attention: "routine",
    primaryAction: { intent: "resolve", label: "Clear" },
    secondaryActions: [{ intent: "open-session", label: "See result" }],
  });

  assert.deepEqual(
    normalizeSynthesizedBriefing({
      headline: "Nothing needs your attention",
      message: "The research is complete and produced no follow-up work.",
      attention: "routine",
      primaryAction: { intent: "resolve", label: "Clear" },
      secondaryActions: [],
    }, "completion"),
    {
      headline: "Nothing needs your attention",
      message: "The research is complete and produced no follow-up work.",
      attention: "routine",
      primaryAction: { intent: "resolve", label: "Clear" },
      secondaryActions: [],
    },
  );
  assert.equal(
    normalizeSynthesizedBriefing({
      headline: "Looks good",
      message: "Ship it.",
      attention: "routine",
      primaryAction: { intent: "approve", label: "Approve" },
      secondaryActions: [],
    }, "completion"),
    null,
  );
});

test("normalizes presentational markdown and tolerates unusable optional actions", () => {
  const parsed = normalizeSynthesizedBriefing({
  "headline": "**The queue is clear**",
  "message": "Review [issue #372](https://example.test/372), then rotate `COPILOT_TOKEN`.",
  "attention": "soon",
  "primaryAction": {"intent": "review", "label": "Review issue #372 in detail because it matters"},
  "secondaryActions": [
    {"intent": "approve", "label": "Invalid for a completion"},
    {"intent": "open-session", "label": "Open source"}
  ]
}, "completion");

  assert.equal(parsed?.headline, "The queue is clear");
  assert.equal(
    parsed?.message,
    "Review issue #372, then rotate COPILOT_TOKEN.",
  );
  assert.ok((parsed?.primaryAction.label.length ?? 0) <= 32);
  assert.deepEqual(parsed?.secondaryActions, [{
    intent: "open-session",
    label: "Open source",
  }]);
});

test("SDK briefing schema restricts actions to the event and requires a complete envelope", () => {
  const value = {
    headline: "Build is over capacity",
    message: "Review active work.",
    attention: "now",
    primaryAction: { intent: "inspect", label: "Review build lane" },
    secondaryActions: [{ intent: "resolve", label: "Clear update" }],
  };
  const schema = briefingResponseSchema("review-escalation", "wip-violation");
  assert.deepEqual(schema.parse(value), value);
  assert.equal(schema.toJSONSchema().additionalProperties, false);
  for (const invalid of [
    { ...value, primaryAction: { intent: "approve", label: "Approve" } },
    { ...value, secondaryActions: [{ intent: "open-session", label: "Open" }] },
    { ...value, secondaryActions: Array(3).fill(value.secondaryActions[0]) },
    { ...value, headline: " " },
    { ...value, message: 5 },
    { ...value, attention: "urgent" },
    { ...value, secondaryActions: undefined },
  ]) {
    assert.equal(schema.safeParse(invalid).success, false);
  }
  assert.equal(normalizeSynthesizedBriefing(JSON.stringify(value), "completion"), null);
});

test("WIP briefings only offer controls with distinct effects", () => {
  assert.deepEqual(
    normalizeSynthesizedBriefing({
      headline: "Build is over capacity",
      message: "Nine active cards are competing for three build slots.",
      attention: "now",
      primaryAction: { intent: "inspect", label: "Review build lane" },
      secondaryActions: [
        { intent: "open-session", label: "Open a session" },
        { intent: "resolve", label: "Clear update" },
      ],
    }, "review-escalation", "wip-violation"),
    {
      headline: "Build is over capacity",
      message: "Nine active cards are competing for three build slots.",
      attention: "now",
      primaryAction: { intent: "inspect", label: "Review build lane" },
      secondaryActions: [{ intent: "resolve", label: "Clear update" }],
    },
  );
});

test("generated copy preserves source identity and records its action choice", () => {
  const current = item();
  const requestId = synthesisRequestId(evidence);
  const draft = applySynthesizedBriefing(
    current,
    {
      headline: "The PR queue is clear",
      message: "Every remaining PR has been reviewed. Nothing needs your attention.",
      attention: "routine",
      primaryAction: { intent: "resolve", label: "Clear" },
      secondaryActions: [{ intent: "open-session", label: "See result" }],
    },
    "test-model",
    "2026-09-22T00:02:00.000Z",
    requestId,
  );

  assert.equal(draft.sourceKey, current.sourceKey);
  assert.equal(draft.sourceRevision, current.sourceRevision);
  assert.equal(draft.title, "The PR queue is clear");
  assert.equal(draft.briefing.recommendedAction?.intent, "resolve");
  assert.equal(draft.briefing.synthesis?.status, "generated");
  assert.equal(draft.briefing.synthesis?.version, "cos-note-v10");
});

test("primary action cannot claim a source fix through an inbox-only resolve", () => {
  assert.equal(
    normalizeSynthesizedBriefing({
      headline: "Build WIP is over the limit",
      message: "Review active build work and defer low-priority cards.",
      attention: "now",
      primaryAction: { intent: "resolve", label: "Reduce build WIP" },
      secondaryActions: [],
    }, "review-escalation"),
    null,
  );

  const current = item();
  const draft = applySynthesizedBriefing(
    current,
    {
      headline: "The queue is clear",
      message: "No follow-up is required.",
      attention: "routine",
      primaryAction: { intent: "resolve", label: "Finish the migration" },
      secondaryActions: [],
    },
    "test-model",
    "2026-09-22T00:02:00.000Z",
    synthesisRequestId(evidence),
  );
  assert.equal(draft.briefing.recommendedAction?.label, "Clear");
});

test("reply labels describe a handoff instead of pretending to execute it", () => {
  const current = {
    ...item(),
    kind: "pending-input" as const,
  };
  const draft = applySynthesizedBriefing(
    current,
    {
      headline: "The draft PR is ready",
      message: "The agent needs permission to push the branch.",
      attention: "now",
      primaryAction: {
        intent: "reply",
        label: "Push branch and open draft PR",
      },
      secondaryActions: [],
    },
    "test-model",
    "2026-09-22T00:02:00.000Z",
    synthesisRequestId(evidence),
  );
  assert.match(draft.briefing.recommendedAction?.label ?? "", /^Reply:/);
  assert.ok((draft.briefing.recommendedAction?.label.length ?? 0) <= 32);
});

test("stale, resolved, and replaced requests reject late synthesis", () => {
  const current = item();
  const requestId = synthesisRequestId(evidence);
  assert.equal(
    canApplySynthesizedBriefing(current, "source-1", requestId),
    true,
  );
  assert.equal(
    canApplySynthesizedBriefing(
      { ...current, workflowState: "resolved" },
      "source-1",
      requestId,
    ),
    false,
  );
  assert.equal(
    canApplySynthesizedBriefing(current, "source-2", requestId),
    false,
  );
  assert.equal(
    canApplySynthesizedBriefing(current, "source-1", "new-request"),
    false,
  );
});

test("request identity ignores volatile card telemetry", () => {
  const first = synthesisRequestId({
    ...evidence,
    session: {
      runtime: "idle",
      attention: "none",
      recentActivity: ["Waiting"],
    },
  });
  const later = synthesisRequestId({
    ...evidence,
    session: {
      runtime: "running",
      attention: "needs-human",
      recentActivity: ["Polling", "Still polling"],
    },
  });
  assert.equal(first, later);
});

test("request identity changes when the source note changes", () => {
  assert.notEqual(
    synthesisRequestId(evidence),
    synthesisRequestId({
      ...evidence,
      currentBriefing: {
        ...evidence.currentBriefing,
        reason: "The final response now includes the completed outcome.",
      },
    }),
  );
});
