import { createHash } from "node:crypto";

import { AHPStatus, type AHPSessionSummary } from "../ahp/types.ts";
import type { HeartbeatAction } from "../orchestrator/heartbeat.ts";
import type { KanbanCard, PendingInput } from "../types.ts";
import type {
  InboxBriefing,
  InboxItemDraft,
  InboxItemKind,
  InboxProjectionOperation,
} from "./types.ts";

interface ProjectionContext {
  hostUrl: string;
  now?: string;
}

function digest(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex")
    .slice(0, 16);
}

function observedAt(context: ProjectionContext): string {
  return context.now ?? new Date().toISOString();
}

function sourceRevision(card: KanbanCard): string {
  if (card.sourceRevision) return card.sourceRevision;
  return `content:${digest({
    activity: card.activity,
    finalResponse: card.lastAgentMessage,
    changes: {
      files: card.filesChanged,
      additions: card.additions,
      deletions: card.deletions,
      paths: (card.fileChanges ?? []).map((file) => file.path),
    },
    artifacts: (card.artifacts ?? []).map((artifact) => ({
      type: artifact.type,
      title: artifact.title,
      status: artifact.status,
    })),
    reviewFindings: card.reviewFindings,
  })}`;
}

function cardTitle(card: Pick<KanbanCard, "title" | "id"> | undefined): string {
  return card?.title.trim() || card?.id || "Agent task";
}

function conciseContext(value: string): string {
  const paragraph = value
    .split(/\n\s*\n/)
    .map((part) => part.trim())
    .find((part) => part && !/^#{1,6}\s+\S/.test(part)) ?? value;
  const normalized = paragraph
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[*~`]/g, "")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
  if (normalized.length <= 320) return normalized;
  const excerpt = normalized.slice(0, 317);
  const sentenceEnd = Math.max(
    excerpt.lastIndexOf(". "),
    excerpt.lastIndexOf("! "),
    excerpt.lastIndexOf("? "),
  );
  if (sentenceEnd >= 120) return excerpt.slice(0, sentenceEnd + 1);
  const wordEnd = excerpt.lastIndexOf(" ");
  return `${excerpt.slice(0, wordEnd > 0 ? wordEnd : 317).trimEnd()}...`;
}

function cardContext(card: KanbanCard, fallback: string): string {
  const context = card.lastAgentMessage?.trim() || card.activity?.trim();
  return context ? conciseContext(context) : fallback;
}

function readinessEvidence(card: KanbanCard): string {
  const parts: string[] = [];
  if (card.filesChanged > 0) {
    parts.push(
      `${card.filesChanged} changed file${card.filesChanged === 1 ? "" : "s"}`,
    );
  }
  const artifacts = [...new Set(
    (card.artifacts ?? []).map((artifact) => artifact.type),
  )];
  if (artifacts.length > 0) parts.push(`${artifacts.join(" and ")} attached`);
  return parts.length > 0 ? `${parts.join("; ")}.` : "";
}

function briefing(
  sourceKey: string,
  eventType: string,
  context: ProjectionContext,
  input: Omit<InboxBriefing, "freshness" | "provenance"> & {
    cardId?: string;
    relatedCardIds?: string[];
    sourceRevision: string;
    sourceModifiedAt?: string;
    sourceType?: InboxBriefing["provenance"]["sourceType"];
  },
): InboxBriefing {
  return {
    message: input.reason,
    recommendation: input.recommendation,
    reason: input.reason,
    alternativeActions: input.alternativeActions,
    outcome: input.outcome,
    caveats: input.caveats,
    confidence: input.confidence,
    synthesis: {
      status: "pending",
    },
    freshness: {
      observedAt: observedAt(context),
      sourceModifiedAt: input.sourceModifiedAt,
    },
    provenance: {
      sourceType: input.sourceType ?? "ahp-session",
      sourceKey,
      eventType,
      hostUrl: context.hostUrl,
      cardId: input.cardId,
      relatedCardIds: input.relatedCardIds,
      sourceRevision: input.sourceRevision,
    },
  };
}

function draft(
  kind: InboxItemKind,
  sourceKey: string,
  revision: string,
  title: string,
  itemBriefing: InboxBriefing,
  cardId?: string,
  relatedCardIds?: string[],
): InboxItemDraft {
  return {
    sourceKey,
    sourceRevision: revision,
    kind,
    cardId,
    relatedCardIds,
    title,
    briefing: itemBriefing,
  };
}

function pendingInputReason(input: PendingInput): string {
  if (input.message?.trim()) return input.message.trim();
  const firstQuestion = input.questions[0];
  return firstQuestion?.message?.trim() ||
    "The agent cannot continue until a human supplies input.";
}

function pendingInputRecommendation(input: PendingInput): string {
  if (input.kind === "toolConfirmation") {
    return "Check what the tool will do, then approve or deny it.";
  }
  if (input.kind === "toolAuthentication") {
    return "Open the session and finish sign-in in VS Code.";
  }

  const firstQuestion = input.questions[0];
  const recommended = firstQuestion?.options?.find((option) => option.recommended);
  if (recommended) return `Reply with "${recommended.label}".`;
  if (firstQuestion?.defaultValue !== undefined) {
    return `Reply with "${String(firstQuestion.defaultValue)}".`;
  }
  return "";
}

function projectPendingInput(
  card: KanbanCard,
  context: ProjectionContext,
): InboxProjectionOperation[] {
  if (!card.pendingInput) {
    return [{ type: "resolve-kind", kind: "pending-input", cardId: card.id }];
  }

  const input = card.pendingInput;
  const sourceKey = `session:${card.id}:pending-input:${input.requestId}`;
  const revision = digest(input);
  const questionCount = input.questions.length;
  const kindLabel = input.kind === "toolConfirmation"
    ? "approval"
    : input.kind === "toolAuthentication"
      ? "sign-in"
      : "a reply";
  return [
    {
      type: "resolve-kind",
      kind: "pending-input",
      cardId: card.id,
      exceptSourceKey: sourceKey,
    },
    {
      type: "upsert",
      item: draft(
        "pending-input",
        sourceKey,
        revision,
        `${cardTitle(card)} needs ${kindLabel}`,
        briefing(sourceKey, "pending-input", context, {
          cardId: card.id,
          sourceRevision: revision,
          sourceModifiedAt: new Date(card.modifiedAt).toISOString(),
          recommendation: pendingInputRecommendation(input),
          reason: pendingInputReason(input),
          alternativeActions: [
            {
              id: "inspect-session",
              label: "Open session",
              description: "Review the agent's recent work and the full request context.",
            },
            {
              id: "dismiss-briefing",
              label: "Dismiss",
              description: "Hide this item without answering the agent.",
            },
          ],
          outcome: questionCount === 1
            ? "Answering the outstanding question lets the agent continue."
            : `Answering ${questionCount} outstanding questions lets the agent continue.`,
          caveats: [
            "Marking this done does not answer the request.",
          ],
          confidence: "high",
        }),
        card.id,
      ),
    },
  ];
}

function projectRuntimeError(
  card: KanbanCard,
  context: ProjectionContext,
): InboxProjectionOperation {
  const sourceKey = `session:${card.id}:runtime-error`;
  if (card.runtime !== "error") {
    return { type: "resolve-source", sourceKey };
  }
  const revision = digest({
    activity: card.activity,
  });
  return {
    type: "upsert",
    item: draft(
      "runtime-error",
      sourceKey,
      revision,
      `${cardTitle(card)} failed`,
      briefing(sourceKey, "runtime-error", context, {
        cardId: card.id,
        sourceRevision: revision,
        sourceModifiedAt: new Date(card.modifiedAt).toISOString(),
        recommendation: "",
        reason: card.activity || "The agent host reports a runtime error.",
        alternativeActions: [
          {
            id: "inspect-session",
            label: "Open session",
            description: "Open the source session to review its error and recent activity.",
          },
          {
            id: "dismiss-briefing",
            label: "Dismiss",
            description: "Hide the item without changing the session.",
          },
        ],
        outcome: "The card stays in its current phase.",
        caveats: [
          "Marking this done does not fix the error.",
        ],
        confidence: "high",
      }),
      card.id,
    ),
  };
}

function projectReadiness(
  card: KanbanCard,
  previousCard: KanbanCard | undefined,
  context: ProjectionContext,
  phase: "review" | "ship",
): InboxProjectionOperation[] {
  const kind = phase === "review" ? "review-ready" : "ship-ready";
  const sourceKey = `card:${card.id}:ready:${phase}`;
  if (card.phase !== phase || card.isArchived) {
    return [{ type: "resolve-source", sourceKey }];
  }
  if (!previousCard) return [];
  const revision = sourceRevision(card);
  const review = phase === "review";
  return [{
    type: "upsert",
    item: draft(
      kind,
      sourceKey,
      revision,
      `${cardTitle(card)} is ready for ${review ? "review" : "ship"}`,
      briefing(sourceKey, `${phase}-ready`, context, {
        cardId: card.id,
        sourceRevision: revision,
        sourceModifiedAt: new Date(card.modifiedAt).toISOString(),
        recommendation: readinessEvidence(card),
        reason: cardContext(
          card,
          review
            ? "The required checks passed and the work is ready for review."
            : "The final checks passed and the work is ready to hand off.",
        ),
        alternativeActions: [
          {
            id: "inspect-evidence",
            label: "Open details",
            description: "Review the artifacts, changes, and checks.",
          },
          {
            id: "leave-open",
            label: "Keep open",
            description: "Leave this item in the queue.",
          },
        ],
        outcome: review
          ? "The work is ready for review."
          : "The work is ready to hand off.",
        caveats: [
          "Feed actions do not move or archive the card.",
        ],
        confidence: "high",
      }),
      card.id,
    ),
  }];
}

function completionOperations(
  card: KanbanCard,
  context: ProjectionContext,
): InboxProjectionOperation[] {
  const revision = sourceRevision(card);
  const sourceKey = `session:${card.id}:completion:${revision}`;
  const artifactTypes = [...new Set(
    (card.artifacts ?? []).map((artifact) => artifact.type),
  )];
  const deliverableSummary = card.filesChanged > 0
    ? `${card.filesChanged} changed file${card.filesChanged === 1 ? "" : "s"}`
    : artifactTypes.length > 0
      ? `${artifactTypes.join(", ")} output`
      : "a completed agent turn";
  return [
    {
      type: "resolve-kind",
      kind: "completion",
      cardId: card.id,
      exceptSourceKey: sourceKey,
    },
    {
      type: "upsert",
      item: draft(
        "completion",
        sourceKey,
        revision,
        `${cardTitle(card)} finished`,
        briefing(sourceKey, card.isArchived ? "session-archived" : "session-idle", context, {
          cardId: card.id,
          sourceRevision: revision,
          sourceModifiedAt: new Date(card.modifiedAt).toISOString(),
          recommendation: "",
          reason: cardContext(card, `Produced ${deliverableSummary}.`),
          alternativeActions: [
            {
              id: "inspect-outcome",
              label: "Open result",
              description: "Review the summary, artifacts, and changes.",
            },
            {
              id: "resolve-briefing",
              label: "Done",
              description: "Remove this item from the queue.",
            },
          ],
          outcome: `The session produced ${deliverableSummary}.`,
          caveats: card.filesChanged === 0
            ? [
                "No code changes were detected; the outcome may be research, analysis, planning, or a no-op.",
                "Completion does not imply that external gates passed.",
              ]
            : ["Completion does not imply that external gates passed."],
          confidence: "high",
        }),
        card.id,
      ),
    },
  ];
}

function projectCompletion(
  card: KanbanCard,
  previousCard: KanbanCard | undefined,
  context: ProjectionContext,
): InboxProjectionOperation[] {
  if (card.runtime !== "idle" && !card.isArchived) {
    return [{
      type: "resolve-kind",
      kind: "completion",
      cardId: card.id,
    }];
  }

  const transitionedToIdle = card.runtime === "idle" &&
    (previousCard?.runtime === "running" ||
      previousCard?.runtime === "input-needed");
  const newlyArchived =
    card.isArchived && previousCard !== undefined && !previousCard.isArchived;
  const finalContextChanged = Boolean(
    previousCard &&
    card.runtime === "idle" &&
    card.lastAgentMessage?.trim() &&
    card.lastAgentMessage !== previousCard.lastAgentMessage,
  );
  if (!newlyArchived && !transitionedToIdle && !finalContextChanged) return [];
  return completionOperations(card, context);
}

export function projectExistingCompletionRefresh(
  card: KanbanCard,
  context: ProjectionContext,
): InboxProjectionOperation[] {
  if (
    card.runtime !== "idle" ||
    card.isArchived ||
    !card.lastAgentMessage?.trim()
  ) {
    return [];
  }
  return completionOperations(card, context);
}

export function projectCardSnapshot(
  card: KanbanCard,
  previousCard: KanbanCard | undefined,
  context: ProjectionContext,
): InboxProjectionOperation[] {
  return [
    ...projectPendingInput(card, context),
    projectRuntimeError(card, context),
    ...projectReadiness(card, previousCard, context, "review"),
    ...projectReadiness(card, previousCard, context, "ship"),
    ...projectCompletion(card, previousCard, context),
  ];
}

export function projectArchivedSession(
  session: AHPSessionSummary,
  context: ProjectionContext,
): InboxProjectionOperation[] {
  if ((session.status & AHPStatus.IsArchived) === 0) return [];
  const revision = `modified:${Date.parse(session.modifiedAt)}`;
  const sourceKey = `session:${session.resource}:completion:${revision}`;
  const fileCount = session.changes?.files ?? 0;
  return [
    ...projectRemovedSession(session.resource),
    {
      type: "resolve-kind",
      kind: "completion",
      cardId: session.resource,
      exceptSourceKey: sourceKey,
    },
    {
      type: "upsert",
      item: draft(
        "completion",
        sourceKey,
        revision,
        `${session.title || session.resource} finished`,
        briefing(sourceKey, "session-archived", context, {
          cardId: session.resource,
          sourceRevision: revision,
          sourceModifiedAt: session.modifiedAt,
          recommendation: fileCount > 0
            ? `Produced ${fileCount} changed file${fileCount === 1 ? "" : "s"}.`
            : "",
          reason: session.activity || "The agent session was archived after completing its work.",
          alternativeActions: [
            { id: "inspect-outcome", label: "Open result" },
            {
              id: "resolve-briefing",
              label: "Done",
              description: "Remove this item from the queue.",
            },
          ],
          outcome: fileCount > 0
            ? `The archived session reports ${fileCount} changed file${fileCount === 1 ? "" : "s"}.`
            : "The archived session completed without detected code changes, which may represent research, analysis, or planning.",
          caveats: [
            "Archived completion does not imply that external gates passed.",
          ],
          confidence: "high",
        }),
        session.resource,
      ),
    },
  ];
}

export function projectRemovedSession(
  cardId: string,
): InboxProjectionOperation[] {
  return [
    { type: "resolve-kind", kind: "pending-input", cardId },
    {
      type: "resolve-source",
      sourceKey: `session:${cardId}:runtime-error`,
    },
    {
      type: "resolve-source",
      sourceKey: `card:${cardId}:ready:review`,
    },
    {
      type: "resolve-source",
      sourceKey: `card:${cardId}:ready:ship`,
    },
  ];
}

function actionRevision(action: HeartbeatAction): string {
  return digest(action);
}

function orchestratorDraft(
  kind: InboxItemKind,
  sourceKey: string,
  action: HeartbeatAction,
  context: ProjectionContext,
  input: {
    card?: KanbanCard;
    relatedCardIds?: string[];
    title: string;
    recommendation: string;
    reason: string;
    outcome: string;
    caveats?: string[];
    confidence?: InboxBriefing["confidence"];
  },
): InboxItemDraft {
  const revision = actionRevision(action);
  const cardId = "cardId" in action ? action.cardId : undefined;
  return draft(
    kind,
    sourceKey,
    revision,
    input.title,
    briefing(sourceKey, action.type, context, {
      sourceType: "orchestrator",
      cardId,
      relatedCardIds: input.relatedCardIds,
      sourceRevision: revision,
      recommendation: input.recommendation,
      reason: input.reason,
      alternativeActions: [
        {
          id: "inspect-evidence",
          label: "Inspect evidence",
          description: "Review the card, gate, or coordinator evidence behind this briefing.",
        },
        {
          id: "dismiss-briefing",
          label: "Dismiss this briefing",
          description: "Hide the briefing without executing its recommendation.",
        },
      ],
      outcome: input.outcome,
      caveats: input.caveats ?? [
        "Inbox actions do not execute coordinator or gate actions.",
      ],
      confidence: input.confidence ?? "high",
    }),
    cardId,
    input.relatedCardIds,
  );
}

export function projectHeartbeatAction(
  action: HeartbeatAction,
  card: KanbanCard | undefined,
  context: ProjectionContext,
): InboxProjectionOperation[] {
  const title = cardTitle(card ?? (
    "cardId" in action ? { id: action.cardId, title: action.cardId } : undefined
  ));

  switch (action.type) {
    case "gate-completed": {
      const sourceKey = `card:${action.cardId}:gate-failure:${action.gateType}`;
      if (action.status === "passed") {
        return [{ type: "resolve-source", sourceKey }];
      }
      return [{
        type: "upsert",
        item: orchestratorDraft(
          "gate-failure",
          sourceKey,
          action,
          context,
          {
            card,
            title: `${title} failed the ${action.gateType} gate`,
            recommendation: "",
            reason: `The required ${action.gateType} gate failed.`,
            outcome: "The gate engine keeps the card in its current phase.",
          },
        ),
      }];
    }
    case "escalated":
    case "plan-approve-failed":
    case "plan-review-failed": {
      const sourceKey = `card:${action.cardId}:escalation:${action.type}`;
      return [{
        type: "upsert",
        item: orchestratorDraft(
          "review-escalation",
          sourceKey,
          action,
          context,
          {
            card,
            title: `${title} needs a decision`,
            recommendation: "",
            reason: action.reason,
            outcome: "Automation is parked; the card phase is unchanged.",
          },
        ),
      }];
    }
    case "risk-assessment-required":
    case "source-revision-required":
      return [];
    case "review-passed":
      return [{
        type: "resolve-source",
        sourceKey: `card:${action.cardId}:escalation:escalated`,
      }];
    case "plan-review-passed":
      return [{
        type: "resolve-source",
        sourceKey: `card:${action.cardId}:escalation:plan-review-failed`,
      }];
    case "coherence-conflict": {
      const pair = [action.cardId, action.otherCardId].sort();
      const sourceKey = `coherence:${pair[0]}:${pair[1]}`;
      return [{
        type: "upsert",
        item: orchestratorDraft(
          "conflict",
          sourceKey,
          action,
          context,
          {
            card,
            relatedCardIds: [action.otherCardId],
            title: `${title} conflicts with another card`,
            recommendation: "",
            reason: action.summary,
            outcome: "The conflict remains external to phase and runtime state, and may block Ship.",
          },
        ),
      }];
    }
    case "coherence-cleared": {
      const pair = [action.cardId, action.otherCardId].sort();
      return [{
        type: "resolve-source",
        sourceKey: `coherence:${pair[0]}:${pair[1]}`,
      }];
    }
    case "coherence-blocked": {
      const sourceKey = `card:${action.cardId}:coherence-blocked`;
      return [{
        type: "upsert",
        item: orchestratorDraft(
          "conflict",
          sourceKey,
          action,
          context,
          {
            card,
            title: `${title} is blocked`,
            recommendation: "",
            reason: action.reason,
            outcome: "The card remains in Review and cannot advance to Ship.",
          },
        ),
      }];
    }
    case "phase-advanced": {
      if (action.to === "review" || action.to === "ship") {
        const kind = action.to === "review" ? "review-ready" : "ship-ready";
        const sourceKey = `card:${action.cardId}:ready:${action.to}`;
        return [{
          type: "upsert",
          item: orchestratorDraft(
            kind,
            sourceKey,
            action,
            context,
            {
              card,
              title: `${title} is ready for ${action.to}`,
              recommendation: card ? readinessEvidence(card) : "",
              reason: card
                ? cardContext(
                    card,
                    `The required checks advanced the work from ${action.from} to ${action.to}.`,
                  )
                : `The required checks advanced the work from ${action.from} to ${action.to}.`,
              outcome: `The persisted board phase is now ${action.to}.`,
              caveats: [
                "Feed actions do not move the card.",
              ],
            },
          ),
        }];
      }
      const sourceKey =
        `card:${action.cardId}:coordinator:${action.type}:${action.from}:${action.to}`;
      return [{
        type: "upsert",
        item: orchestratorDraft(
          "coordinator-action",
          sourceKey,
          action,
          context,
          {
            card,
            title: `${title} advanced to ${action.to}`,
            recommendation: "",
            reason: `The gate engine advanced the persisted phase from ${action.from} to ${action.to}.`,
            outcome: `The card is now in ${action.to}.`,
          },
        ),
      }];
    }
    case "auto-answered":
    case "plan-approved":
    case "plan-feedback-delivered": {
      const sourceKey =
        `card:${action.cardId}:coordinator:${action.type}:${actionRevision(action)}`;
      const reason = action.type === "auto-answered"
        ? `The coordinator answered: ${action.answer}`
        : action.type === "plan-approved"
          ? "The coordinator approved the plan under its configured authority."
          : "The coordinator delivered review feedback to the planning session.";
      return [{
        type: "upsert",
        item: orchestratorDraft(
          "coordinator-action",
          sourceKey,
          action,
          context,
          {
            card,
            title: `Coordinator updated ${title}`,
            recommendation: "",
            reason,
            outcome: "The action is recorded in the audit log.",
          },
        ),
      }];
    }
    case "wip-violation": {
      const sourceKey = `orchestrator:wip:${action.phase}`;
      return [{
        type: "resolve-source",
        sourceKey,
      }];
    }
    case "wip-cleared":
      return [{
        type: "resolve-source",
        sourceKey: `orchestrator:wip:${action.phase}`,
      }];
    default:
      return [];
  }
}
