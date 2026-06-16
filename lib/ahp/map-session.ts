import { Artifact, KanbanCard, Phase, RuntimeStatus } from "@/lib/types";
import { assessRisk } from "@/lib/orchestrator/risk-assessor";

import { AHPSessionSummary, parseAHPStatus } from "./types";

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
  artifacts: Artifact[]
): Phase {
  if (existingPhase) return existingPhase;

  const activity = (session.activity ?? "").toLowerCase();
  const hasChanges = (session.changes?.files ?? 0) > 0;
  const hasPlanArtifact = artifacts.some((a) => a.type === "plan");

  // Review keywords + idle with changes → review
  if (REVIEW_KEYWORDS.test(activity) && hasChanges) return "review";

  // Code changes present → build
  if (hasChanges) return "build";

  // Plan artifact or plan-related activity → plan
  if (hasPlanArtifact || PLAN_KEYWORDS.test(activity)) return "plan";

  return "define";
}

export function mapSessionToCard(
  session: AHPSessionSummary,
  existingPhase?: Phase
): KanbanCard {
  const runtime = mapAHPRuntimeStatus(session.status);
  const artifacts = inferArtifacts(session);
  const phase = inferPhase(session, existingPhase, artifacts);
  const additions = session.changes?.additions || 0;
  const deletions = session.changes?.deletions || 0;
  const filesChanged = session.changes?.files || 0;
  const risk = assessRisk({
    title: session.title,
    activity: session.activity,
    filesChanged,
    additions,
    deletions,
  });

  return {
    id: session.resource,
    title: session.title,
    phase,
    runtime,
    gateStatus: phase === "review" ? "evaluating" : phase === "ship" ? "passed" : "pending",
    attention:
      runtime === "input-needed"
        ? "needs-human"
        : runtime === "error"
          ? "error"
          : "none",
    risk: risk.level,
    activity: session.activity || "No activity",
    additions,
    deletions,
    filesChanged,
    // TODO: Derive planSteps from session turns[] via session-level subscription
    planSteps: { total: 0, done: 0 },
    modifiedAt: new Date(session.modifiedAt).getTime(),
    model: session.model,
    // TODO: Extract branch from SessionState._meta["git"] via session subscription
    branch: undefined,
    workingDirectory: session.workingDirectory,
    project: session.project,
    artifacts: artifacts.length > 0 ? artifacts : undefined,
  };
}
