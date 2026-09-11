import { NextRequest, NextResponse } from "next/server";

import {
  startReview,
  getReviewRunsForCard,
} from "@/lib/orchestrator/review-executor";
import {
  loadConfig,
  getApplicableSkills,
} from "@/lib/orchestrator/skill-config";
import type { RiskLevel } from "@/lib/types";
import { getRiskForAutomation } from "@/lib/orchestrator/risk-store";
import { getDb } from "@/lib/db/schema";
import {
  getCardPhase,
} from "@/lib/orchestrator/gate-engine";
import { resolveAuthoritativeGateRevision } from "@/lib/orchestrator/gate-revision";
import { normalizeChangesetRef } from "@/lib/types";
import { validateLocalMutationRequest } from "@/lib/http/local-mutation";

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

  const config = loadConfig();
  const skill = config.skills[skillId];
  if (!skill) {
    return NextResponse.json(
      { error: `Unknown skill: ${skillId}` },
      { status: 400 }
    );
  }

  const transition = phaseTransition ?? "review->ship";
  const phase = getCardPhase(cardId);
  const revision = resolveAuthoritativeGateRevision(
    getDb(),
    cardId,
    phase,
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
  const risk = getRiskForAutomation(cardId, hostUrl);

  const { reviewRunId, success } = await startReview(
    hostUrl,
    sessionUri,
    cardId,
    skill,
    transition,
    risk,
    revision.changesetRef,
    { signal: request.signal },
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
    status: "injected",
    startedAt: new Date().toISOString(),
  });
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
