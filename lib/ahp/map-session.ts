import { Artifact, KanbanCard, PendingInput, PendingInputQuestion, PendingInputOptionKind, Phase, RiskLevel, RuntimeStatus, ToolConfirmationDetails, ToolConfirmationOption } from "@/lib/types";
import type {
  ChatInputRequest,
  ChatInputQuestion,
  SessionState,
  SessionChatInputRequest,
  SessionToolConfirmationRequest,
  SessionToolClientExecutionRequest,
} from "@microsoft/agent-host-protocol";

import { AHPSessionSummary, AHPStatus, parseAHPStatus } from "./types";
import type { ChangesetEnrichment } from "./changeset-enricher";

/**
 * Convert a session's aggregated `SessionState.inputNeeded` into the single most
 * actionable {@link PendingInput}. This is the AHP 0.5 session-level input surface,
 * covering elicitations, tool confirmations, and client-execution across every chat.
 *
 * Priority (most actionable first): user elicitation → tool confirmation →
 * read-only client-execution blocker.
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
      intent: (o.kind as string) === "deny" ? "deny" : "approve",
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
  };

  return {
    requestId: entry.id,
    kind: "toolConfirmation",
    message: title ? `Confirm: ${title}` : "Confirm tool call",
    questions: [],
    toolConfirmation: details,
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

const PLAN_KEYWORDS = /\bplan\b|plan\.md|planning|spec|specification|drafting.*plan/i;
const REVIEW_KEYWORDS = /\breview\b|reviewing|code review|PR review|approval/i;

/**
 * Extract Artifact entries from annotations and activity signals.
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

  // Infer a plan artifact from activity text when no explicit annotation exists
  if (!seen.has("plan:inferred") && session.activity && PLAN_KEYWORDS.test(session.activity)) {
    artifacts.push({
      id: "inferred-plan",
      type: "plan",
      title: "plan.md",
      createdAt: new Date(session.modifiedAt).getTime(),
      createdBy: "agent",
      status: "draft",
    });
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
  const activity = (session.activity ?? "").toLowerCase();
  const hasPlanArtifact = artifacts.some((a) => a.type === "plan");
  const hasPlanSignal = hasPlanArtifact || PLAN_KEYWORDS.test(activity);

  // Split "code changes" into definite (enrichment-backed) vs ambiguous (raw count).
  // Without enrichment, raw file counts include plan/spec artifacts so we can't
  // assume they represent code changes — unless the count is high enough that
  // plan-only work can't explain it (plan files rarely exceed 2).
  const PLAN_ONLY_FILE_THRESHOLD = 2;
  const hasDefiniteCodeChanges = codeFileCount !== undefined ? codeFileCount > 0 : false;
  const hasAmbiguousFileChanges = codeFileCount === undefined && totalFiles > 0;
  const hasCodeChanges = hasDefiniteCodeChanges
    || (hasAmbiguousFileChanges && !hasPlanSignal)
    || (hasAmbiguousFileChanges && totalFiles > PLAN_ONLY_FILE_THRESHOLD);

  // Archived sessions with code changes are completed work → ship
  if (isArchived && hasCodeChanges) return "ship";

  // Persisted phases past the default 'define' are authoritative — respect
  // deliberate/gate-driven progression and never re-infer over them.
  if (existingPhase && existingPhase !== "define") return existingPhase;

  // A card persisted as the default 'define' phase gets stranded once it gains
  // code: the persisted-phase short-circuit above used to return 'define'
  // before the code checks below ever ran. Let *confirmed* code changes
  // re-promote it — the same classification a brand-new card with code would
  // receive. Non-code diffs (codeFileCount 0/undefined, e.g. plan/notes files)
  // keep it in Define, so plan-only work isn't mislabeled as Build.
  if (existingPhase === "define" && !hasDefiniteCodeChanges) return "define";

  // Review keywords + code changes → review
  if (REVIEW_KEYWORDS.test(activity) && hasCodeChanges) return "review";

  // Code changes present → build
  if (hasCodeChanges) return "build";

  // Plan artifact or plan-related activity → plan
  if (hasPlanArtifact || PLAN_KEYWORDS.test(activity)) return "plan";

  return "define";
}

export function mapSessionToCard(
  session: AHPSessionSummary,
  existingPhase?: Phase,
  enrichment?: ChangesetEnrichment | null,
  persistedRisk?: RiskLevel
): KanbanCard {
  const runtime = mapAHPRuntimeStatus(session.status);
  const artifacts = enrichment?.artifacts ?? inferArtifacts(session);
  const codeFileCount = enrichment?.codeFileCount;
  const phase = inferPhase(session, existingPhase, artifacts, codeFileCount);
  const isArchived = (session.status & AHPStatus.IsArchived) !== 0;
  const additions = session.changes?.additions || 0;
  const deletions = session.changes?.deletions || 0;
  const filesChanged = session.changes?.files || 0;

  return {
    id: session.resource,
    title: session.title,
    phase,
    runtime: isArchived ? "idle" : runtime,
    gateStatus: isArchived ? "passed" : phase === "review" ? "evaluating" : phase === "ship" ? "passed" : "pending",
    attention: isArchived ? "none"
      : runtime === "input-needed"
        ? "needs-human"
        : runtime === "error"
          ? "error"
          : "none",
    risk: persistedRisk ?? "low",
    activity: session.activity || (runtime === "running" ? "Thinking" : ""),
    additions,
    deletions,
    filesChanged,
    planSteps: { total: 0, done: 0 },
    modifiedAt: new Date(session.modifiedAt).getTime(),
    model: session.model,
    branch: undefined,
    workingDirectory: session.workingDirectory,
    project: session.project,
    artifacts: artifacts.length > 0 ? artifacts : undefined,
    lastAgentMessage: enrichment?.lastAgentMessage,
    fileChanges: enrichment?.fileChanges.length ? enrichment.fileChanges : undefined,
    isArchived,
  };
}
