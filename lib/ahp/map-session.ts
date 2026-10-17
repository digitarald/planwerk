import { Artifact, KanbanCard, PendingInput, PendingInputQuestion, PendingInputOptionKind, Phase, RiskLevel, RuntimeStatus, ToolAuthenticationDetails, ToolConfirmationDetails, ToolConfirmationOption, WorkerActivity } from "@/lib/types";
import type {
  ChatInputRequest,
  ChatInputQuestion,
  SessionState,
  SessionChatInputRequest,
  SessionToolAuthenticationRequest,
  SessionToolConfirmationRequest,
  SessionToolClientExecutionRequest,
} from "@microsoft/agent-host-protocol";

import { visibleChatCatalog } from "./chat-facts";

import { AHPSessionSummary, AHPStatus, parseAHPStatus } from "./types";
import type { ChangesetEnrichment } from "./changeset-enricher";
import {
  sourceBindingsMatch,
  sourceEvidenceRevision,
  type EvidenceSourceBinding,
} from "./source-binding-match";
import {
  normalizeToolRiskAssessment,
  toolAuthenticationHandoff,
  toolConfirmationIntent,
} from "./tool-safety";

/**
 * Convert a session's aggregated `SessionState.inputNeeded` into the single most
 * actionable {@link PendingInput}. This session-level input surface
 * covering elicitations, tool confirmations, authentication handoffs, and client-execution across every chat.
 *
 * Priority (most actionable first): user elicitation → tool confirmation →
 * read-only authentication handoff → read-only client-execution blocker.
 *
 * `SessionInputRequestKind` / `ToolCallStatus` are ambient `const enum`s, which
 * cannot be referenced as values under `isolatedModules`; we compare their string
 * wire values and narrow the discriminated union with a documented cast.
 */
export function mapSessionInputNeeded(
  entries: SessionState["inputNeeded"],
): PendingInput | undefined {
  if (!entries || entries.length === 0) return undefined;

  const chatInput = entries.find((e) => (e.kind as string) === "chatInput");
  if (chatInput) {
    const mapped = mapInputRequests([(chatInput as SessionChatInputRequest).request]);
    if (mapped) return mapped;
  }

  const toolConfirm = entries.find((e) => (e.kind as string) === "toolConfirmation");
  if (toolConfirm) {
    return mapToolConfirmation(toolConfirm as SessionToolConfirmationRequest);
  }

  const toolAuth = entries.find((e) => (e.kind as string) === "toolAuthentication");
  if (toolAuth) {
    return mapToolAuthentication(toolAuth as SessionToolAuthenticationRequest);
  }

  const toolExec = entries.find((e) => (e.kind as string) === "toolClientExecution");
  if (toolExec) {
    const entry = toolExec as SessionToolClientExecutionRequest;
    const name = entry.toolCall?.displayName ?? entry.toolCall?.toolName;
    return {
      requestId: entry.id,
      kind: "toolExecution",
      message: name ? `Waiting on client tool: ${name}` : "Waiting on a client-provided tool",
      questions: [],
    };
  }

  return undefined;
}

function mapToolConfirmation(entry: SessionToolConfirmationRequest): PendingInput {
  const tc = entry.toolCall;
  const confirmKind: "param" | "result" =
    (tc.status as string) === "pending-result-confirmation" ? "result" : "param";

  let options: ToolConfirmationOption[] | undefined;
  if ("options" in tc && Array.isArray(tc.options)) {
    options = tc.options.map((o) => ({
      id: o.id,
      label: o.label,
      intent: toolConfirmationIntent(o.kind),
    }));
  }

  const rawTitle = "confirmationTitle" in tc ? tc.confirmationTitle : undefined;
  const title = typeof rawTitle === "string" && rawTitle.trim() ? rawTitle : (tc.displayName ?? tc.toolName);

  const details: ToolConfirmationDetails = {
    chatUri: entry.chat,
    turnId: entry.turnId,
    toolCallId: tc.toolCallId,
    confirmKind,
    toolName: tc.displayName ?? tc.toolName,
    intention: tc.intention,
    options,
    riskAssessment: normalizeToolRiskAssessment(
      "riskAssessment" in tc ? tc.riskAssessment : undefined,
    ),
  };

  return {
    requestId: entry.id,
    kind: "toolConfirmation",
    message: title ? `Confirm: ${title}` : "Confirm tool call",
    questions: [],
    toolConfirmation: details,
  };
}

function mapToolAuthentication(entry: SessionToolAuthenticationRequest): PendingInput {
  const handoff = toolAuthenticationHandoff(entry.toolCall);
  const details: ToolAuthenticationDetails = { toolName: handoff.toolName };
  return {
    requestId: entry.id,
    kind: "toolAuthentication",
    message: handoff.message,
    questions: [],
    toolAuthentication: details,
  };
}

/**
 * Convert SDK ChatInputRequest[] into the first actionable PendingInput.
 * Only surfaces the first non-answered request to avoid overwhelming the card.
 */
export function mapInputRequests(requests: ChatInputRequest[] | undefined): PendingInput | undefined {
  if (!requests || requests.length === 0) return undefined;

  const req = requests[0];
  const questions: PendingInputQuestion[] = (req.questions ?? []).map(mapQuestion);

  return {
    requestId: req.id,
    message: req.message,
    questions,
  };
}

function mapQuestion(q: ChatInputQuestion): PendingInputQuestion {
  const base: PendingInputQuestion = {
    id: q.id,
    kind: q.kind as PendingInputOptionKind,
    message: q.message,
    title: q.title,
    required: q.required,
  };

  if ("options" in q && q.options) {
    base.options = q.options.map((o) => ({
      id: o.id,
      label: o.label,
      description: o.description,
      recommended: o.recommended,
    }));
  }

  if ("allowFreeformInput" in q) {
    base.allowFreeform = q.allowFreeformInput;
  }

  if ("defaultValue" in q && q.defaultValue !== undefined) {
    base.defaultValue = q.defaultValue;
  }

  return base;
}

export function mapAHPRuntimeStatus(statusBits: number): RuntimeStatus {
  const parsed = parseAHPStatus(statusBits);
  if (parsed.isError) return "error";
  if (parsed.isInputNeeded) return "input-needed";
  if (parsed.isInProgress) return "running";
  return "idle";
}

/**
 * Extract Artifact entries from session annotations.
 */
function inferArtifacts(session: AHPSessionSummary): Artifact[] {
  const artifacts: Artifact[] = [];
  const seen = new Set<string>();

  // Map structured annotations → artifacts
  if (session.annotations) {
    for (const ann of session.annotations) {
      const kind = ann.kind?.toLowerCase() ?? "";
      const title = ann.title;
      const key = `${kind}:${title}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const type =
        kind === "plan" || title.toLowerCase().includes("plan")
          ? "plan"
          : kind === "review" || title.toLowerCase().includes("review")
            ? "review"
          : kind === "research"
            ? "research"
            : kind === "design"
              ? "design"
              : kind === "spec"
                ? "spec"
                : kind === "test-plan" || kind === "test"
                  ? "test-plan"
                  : kind === "decision"
                    ? "decision"
                    : "plan";

      artifacts.push({
        id: `ann-${artifacts.length}`,
        type,
        title,
        contentRef: ann.description,
        createdAt: new Date(session.modifiedAt).getTime(),
        createdBy: "agent",
        status: "draft",
      });
    }
  }

  return artifacts;
}

/**
 * Derive the most likely phase from session signals.
 * Priority: existingPhase > inferred from data > "define".
 */
function inferPhase(
  session: AHPSessionSummary,
  existingPhase: Phase | undefined,
  artifacts: Artifact[],
  codeFileCount?: number
): Phase {
  const isArchived = (session.status & AHPStatus.IsArchived) !== 0;
  const totalFiles = session.changes?.files ?? 0;
  const hasPlanArtifact = artifacts.some((a) => a.type === "plan");

  // Split "code changes" into definite (enrichment-backed) vs ambiguous (raw count).
  // Without enrichment, raw file counts include plan/spec artifacts so we can't
  // assume they represent code changes — unless the count is high enough that
  // plan-only work can't explain it (plan files rarely exceed 2).
  const PLAN_ONLY_FILE_THRESHOLD = 2;
  const hasDefiniteCodeChanges = codeFileCount !== undefined ? codeFileCount > 0 : false;
  const hasAmbiguousFileChanges = codeFileCount === undefined && totalFiles > 0;
  const hasCodeChanges = hasDefiniteCodeChanges
    || (hasAmbiguousFileChanges && !hasPlanArtifact)
    || (hasAmbiguousFileChanges && totalFiles > PLAN_ONLY_FILE_THRESHOLD);

  // Archived sessions with code changes are completed work → ship
  if (isArchived && hasCodeChanges) return "ship";

  // Persisted phases past the default 'define' are authoritative — respect
  // deliberate/gate-driven progression and never re-infer over them.
  if (existingPhase && existingPhase !== "define") return existingPhase;

  // A card persisted as the default 'define' phase only leaves Define on a
  // genuine signal — otherwise ambiguous raw file counts (e.g. a lone plan.md
  // with no enrichment yet) could mislabel it as Build. Two ways out:
  //   1. A plan artifact advances it to Plan. Producing a plan is exactly what
  //      ends the Define stage, so this must win *before* the code checks — a
  //      plan-only card has no definite code changes and would otherwise be
  //      pinned in Define forever.
  //   2. *Confirmed* (enrichment-backed) code changes re-promote it to
  //      Build/Review, the same classification a brand-new card with code gets.
  // Without either signal it stays in Define.
  if (existingPhase === "define" && !hasDefiniteCodeChanges) {
    return hasPlanArtifact ? "plan" : "define";
  }

  // Code changes present → build. (Review is a gated phase, reached only via the
  // gate engine or a persisted transition — never inferred from session facts.)
  if (hasCodeChanges) return "build";

  // Plan artifact present → plan
  if (hasPlanArtifact) return "plan";

  return "define";
}

export function mapSessionToCard(
  session: AHPSessionSummary,
  existingPhase?: Phase,
  enrichment?: ChangesetEnrichment | null,
  persistedRisk?: RiskLevel,
  workers?: WorkerActivity[],
): KanbanCard {
  const summarySource = (
    session as AHPSessionSummary & {
      _planwerkRiskFacts?: EvidenceSourceBinding;
    }
  )._planwerkRiskFacts;
  const enrichmentSource = (
    enrichment as (ChangesetEnrichment & {
      _planwerkSource?: EvidenceSourceBinding;
    }) | null | undefined
  )?._planwerkSource;
  // Live root summaries do not contain persisted bindings. Their timestamp is
  // only an invalidation fence; this display fallback is not byte-freshness proof.
  const bindingMatches = summarySource === undefined
    ? enrichmentSource === undefined || (
      sourceBindingsMatch(enrichmentSource, enrichmentSource) &&
      enrichmentSource.planVersion === session.modifiedAt
    )
    : sourceBindingsMatch(summarySource, enrichmentSource)
      && enrichmentSource?.planVersion === session.modifiedAt;
  if (!bindingMatches) enrichment = null;
  const runtime = mapAHPRuntimeStatus(session.status);
  const artifacts = enrichment?.artifacts ?? inferArtifacts(session);
  const codeFileCount = enrichment?.codeFileCount;
  const phase = inferPhase(session, existingPhase, artifacts, codeFileCount);
  const isArchived = (session.status & AHPStatus.IsArchived) !== 0;
  // Unbound/stale enrichment cannot supply verified counts or plan content.
  const changesetVerified = enrichment?.changesetVerified === true;
  const sourceRevision = changesetVerified ? sourceEvidenceRevision(enrichmentSource) : undefined;
  const additions = changesetVerified ? enrichment!.additions : (session.changes?.additions || 0);
  const deletions = changesetVerified ? enrichment!.deletions : (session.changes?.deletions || 0);
  const filesChanged = changesetVerified ? enrichment!.totalFileCount : (session.changes?.files || 0);

  return {
    id: session.resource,
    title: session.title,
    evidence: {
      state: enrichment ? "current" : session.lastEvidenceCapture ? "stale" : "unavailable",
      capture: enrichment?.evidenceCapture ?? session.lastEvidenceCapture,
    },
    phase,
    runtime: isArchived ? "idle" : runtime,
    gateStatus: isArchived ? "passed" : phase === "review" ? "evaluating" : phase === "ship" ? "passed" : "pending",
    attention: isArchived ? "none"
      : runtime === "input-needed"
        ? "needs-human"
        : runtime === "error"
          ? "error"
          : "none",
    risk: persistedRisk ?? "high",
    activity: session.activity || (runtime === "running" ? "Thinking" : ""),
    additions,
    deletions,
    filesChanged,
    changesetVerified,
    sourceRevision,
    planContentHash: enrichment?.planContentHash,
    planSteps: { total: 0, done: 0 },
    modifiedAt: new Date(session.modifiedAt).getTime(),
    model: session.model,
    branch: undefined,
    workingDirectory: session.workingDirectory,
    workingDirectories: session.workingDirectories,
    project: session.project,
    artifacts: artifacts.length > 0 ? artifacts : undefined,
    lastAgentMessage: enrichment?.lastAgentMessage,
    runtimeError: enrichment?.runtimeError,
    fileChanges: enrichment?.fileChanges.length ? enrichment.fileChanges : undefined,
    changesetReview: enrichment?.changesetReview,
    isArchived,
    workers,
    chats: visibleChatCatalog(session.chats),
    defaultChat: session.defaultChat,
    chatDetails: session.chatDetails,
    backgroundWork: session.backgroundWork,
  };
}
