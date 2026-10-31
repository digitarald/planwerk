import { getCachedSession } from "../db/session-cache";
import { getGateRunsForCard, getNextPhase, getPersistedCardPhase } from "./gate-engine";
import { getEffectiveCoordinatorMode } from "./coordinator-mode-store";
import { resolveAuthoritativeGateRevision } from "./gate-revision";
import { getDb } from "../db/schema";
import type { KanbanCard, Phase } from "../types";
import type { ToolCallResult } from "./orchestrator-tools";
import { getApplicableSkills, loadConfig } from "./skill-config";
import { getRiskForAutomation } from "./risk-store";

export function queryCoordinatorSessions(
  name: string,
  args: Record<string, unknown>,
  hostUrl: string,
  cards: KanbanCard[],
): ToolCallResult {
  const offset = typeof args.offset === "number" && Number.isSafeInteger(args.offset) ? Math.max(0, args.offset) : 0;
  const limit = typeof args.limit === "number" && Number.isSafeInteger(args.limit) ? Math.min(25, Math.max(1, args.limit)) : 20;
  const summary = (card: KanbanCard) => ({
    id: card.id, title: card.title.slice(0, 500), workspace: card.project?.path,
    workingDirectory: card.workingDirectory, phase: card.phase, runtime: card.runtime,
    mode: getEffectiveCoordinatorMode(hostUrl, card.id),
    blocker: (card.gateBlocker ?? card.automationWait?.summary)?.slice(0, 2_000),
    sourceRevision: card.sourceRevision, planContentHash: card.planContentHash,
    evidence: card.evidence,
  });
  if (name === "list_sessions") {
    const query = typeof args.query === "string" ? args.query.toLowerCase() : "";
    const matches = cards.filter((card) =>
      `${card.title} ${card.id} ${card.project?.path ?? ""}`.toLowerCase().includes(query)
    ).sort((a, b) => a.id.localeCompare(b.id));
    return {
      success: true, message: `${matches.length} scoped sessions. Listing is not evidence of task completion.`,
      data: { sessions: matches.slice(offset, offset + limit).map(summary), total: matches.length,
        nextOffset: offset + limit < matches.length ? offset + limit : null },
    };
  }
  const card = cards.find((item) => item.id === args.cardId);
  if (!card) return { success: false, message: "Session is unavailable or outside the selected workspace scope." };
  const cached = getCachedSession(hostUrl, card.id);
  const provenance = {
    source: "server-cache", sourceRevision: card.sourceRevision,
    capturedAt: card.evidence?.capture?.capturedAt,
    evidence: card.evidence, availability: card.lastAgentMessage ? "cached" : "unavailable",
    handoff: "Open the session or explicitly Refresh evidence for uncaptured or stale details. No session was restored.",
  };
  if (name === "read_session_messages") {
    const messages = card.outcomeEvidence || card.lastAgentMessage
      ? [{ kind: "latest-agent-outcome", text: card.outcomeEvidence?.text ?? card.lastAgentMessage?.slice(0, 12_000),
        chatUri: card.outcomeEvidence?.chatUri, turnId: card.outcomeEvidence?.turnId }]
      : [];
    return {
      success: true, message: "Cached outcome window only; this is not a full transcript.",
      data: { id: card.id, messages: messages.slice(offset, offset + limit),
        nextOffset: null, truncated: card.outcomeEvidence?.truncated ?? Boolean(card.lastAgentMessage), provenance },
    };
  }
  const revisions = new Map<Phase, ReturnType<typeof resolveAuthoritativeGateRevision>>();
  const revisionFor = (phase: Phase) => {
    const existing = revisions.get(phase);
    if (existing) return existing;
    const revision = resolveAuthoritativeGateRevision(getDb(), card.id, phase, hostUrl);
    revisions.set(phase, revision);
    return revision;
  };
  const reviewedPhase = card.pendingInput?.planReview !== undefined ? "plan" : getPersistedCardPhase(card.id) ?? card.phase;
  const next = getNextPhase(reviewedPhase);
  const plan = cached?.enrichment?.planContent;
  return {
    success: true, message: `Cached evidence for ${card.title}. Idle and delivery are not task success.`,
    data: {
      ...summary(card), provenance, outcome: card.lastAgentMessage?.slice(0, 12_000),
      runtimeError: card.runtimeError, pendingInput: card.pendingInput,
      plan: plan?.slice(0, 12_000),
      planTruncated: (plan?.length ?? 0) > 12_000,
      planSource: cached?.enrichment?.planSource,
      availableReviewSkills: next ? getApplicableSkills(`${reviewedPhase}->${next}`,
        getRiskForAutomation(card.id, hostUrl), loadConfig(card.workingDirectory)).map((skill) => ({
          id: skill.id, transition: `${reviewedPhase}->${next}`,
        })) : [],
      planSteps: card.planSteps, reviewFindings: card.reviewFindings?.slice(0, 20),
      gates: getGateRunsForCard(card.id).slice(0, 20).map((gate) => {
        const revision = revisionFor(gate.fromPhase);
        return { ...gate, output: gate.output?.slice(0, 2_000),
          current: revision.ok && gate.changesetRef === revision.changesetRef };
      }),
    },
  };
}
