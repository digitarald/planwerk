import { NextRequest, NextResponse } from "next/server";

import {
  startReview,
  getReviewRunsForCard,
} from "@/lib/orchestrator/review-executor";
import {
  loadConfig,
  getApplicableSkills,
} from "@/lib/orchestrator/skill-config";
import { PHASE_ORDER, type RiskLevel } from "@/lib/types";
import { getRiskForAutomation } from "@/lib/orchestrator/risk-store";
import { getDb } from "@/lib/db/schema";
import {
  getCardPhase,
  getNextPhase,
} from "@/lib/orchestrator/gate-engine";
import { resolveAuthoritativeGateRevision } from "@/lib/orchestrator/gate-revision";
import { normalizeChangesetRef } from "@/lib/types";
import { validateLocalMutationRequest } from "@/lib/http/local-mutation";
import { getCachedSession } from "@/lib/db/session-cache";
import { ahpErrorResponse } from "@/lib/ahp/api-error";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const requestError = validateLocalMutationRequest(request);
  if (requestError) {
    return NextResponse.json({ error: requestError }, { status: 403 });
  }

  const { cardId, skillId, phaseTransition, hostUrl, sessionUri, changesetRef } =
    (await request.json()) as {
      cardId?: string;
      skillId?: string;
      phaseTransition?: string;
      hostUrl?: string;
      sessionUri?: string;
      changesetRef?: string;
    };

  if (!cardId || !skillId) {
    return NextResponse.json(
      { error: "cardId and skillId required" },
      { status: 400 }
    );
  }

  if (!hostUrl || !sessionUri) {
    return NextResponse.json(
      { error: "hostUrl and sessionUri required to inject review" },
      { status: 400 }
    );
  }

  if (sessionUri !== cardId) {
    return NextResponse.json({ error: "sessionUri must identify the reviewed card" }, { status: 400 });
  }
  const cached = getCachedSession(hostUrl, cardId);
  const phase = getCardPhase(cardId);
  const transition = phaseTransition ?? `${phase}->${getNextPhase(phase)}`;
  const reviewedPhase = PHASE_ORDER.find((phase) =>
    getNextPhase(phase) !== null && transition === `${phase}->${getNextPhase(phase)}`);
  if (!reviewedPhase) {
    return NextResponse.json({ error: "A valid adjacent phaseTransition is required" }, { status: 400 });
  }
  const config = loadConfig(cached?.summary.workingDirectory);
  const risk = getRiskForAutomation(cardId, hostUrl);
  const skill = getApplicableSkills(transition, risk, config).find((skill) => skill.id === skillId);
  if (!skill) {
    return NextResponse.json(
      { error: `Skill ${skillId} is not configured for ${transition} at ${risk} risk` },
      { status: 400 }
    );
  }

  const revision = resolveAuthoritativeGateRevision(
    getDb(),
    cardId,
    reviewedPhase,
    hostUrl,
  );
  if (!revision.ok) {
    return NextResponse.json(
      {
        error: "Authoritative revision unavailable",
        detail: revision.reason,
        retryable: true,
      },
      { status: 409 },
    );
  }
  if (
    changesetRef !== undefined
    && normalizeChangesetRef(changesetRef)
      !== normalizeChangesetRef(revision.changesetRef)
  ) {
    return NextResponse.json(
      { error: "Changeset revision does not match current AHP facts", stale: true },
      { status: 409 },
    );
  }
  try {
    const { reviewRunId, success, started } = await startReview(
      hostUrl,
      sessionUri,
      cardId,
      skill,
      transition,
      risk,
      revision.changesetRef,
      { signal: request.signal, independent: true },
    );

    if (!success) {
      return NextResponse.json(
        { error: "Failed to start review", reviewRunId },
        { status: 502 }
      );
    }

    return NextResponse.json({
      cardId,
      skillId,
      reviewRunId,
      phaseTransition: transition,
      riskLevel: risk,
      status: started === false ? "existing" : "injected",
      ...(started === false ? {} : { startedAt: new Date().toISOString() }),
    });
  } catch (error) {
    console.error("[ahp:review] Failed to start configured review:", error);
    return ahpErrorResponse(error, "Failed to start review");
  }
}

export async function GET(request: NextRequest) {
  const cardId = request.nextUrl.searchParams.get("cardId");
  const phaseTransition =
    request.nextUrl.searchParams.get("transition") || "plan->build";
  const requestedRisk = (request.nextUrl.searchParams.get("risk") ||
    "medium") as RiskLevel;
  const riskLevel = cardId
    ? getRiskForAutomation(cardId)
    : requestedRisk;

  // If cardId provided, return review runs for that card
  if (cardId) {
    const runs = getReviewRunsForCard(cardId);
    return NextResponse.json({ runs });
  }

  // Otherwise return available skills for the transition + risk
  const skills = getApplicableSkills(phaseTransition, riskLevel);

  return NextResponse.json({ skills, phaseTransition, riskLevel });
}
