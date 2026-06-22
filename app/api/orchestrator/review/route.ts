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

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const { cardId, skillId, phaseTransition, riskLevel, hostUrl, sessionUri, changesetRef } =
    (await request.json()) as {
      cardId?: string;
      skillId?: string;
      phaseTransition?: string;
      riskLevel?: RiskLevel;
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
  const risk = riskLevel ?? "medium";

  const { reviewRunId, success } = await startReview(
    hostUrl,
    sessionUri,
    cardId,
    skill,
    transition,
    risk,
    changesetRef
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
  const riskLevel = (request.nextUrl.searchParams.get("risk") ||
    "medium") as RiskLevel;

  // If cardId provided, return review runs for that card
  if (cardId) {
    const runs = getReviewRunsForCard(cardId);
    return NextResponse.json({ runs });
  }

  // Otherwise return available skills for the transition + risk
  const skills = getApplicableSkills(phaseTransition, riskLevel);

  return NextResponse.json({ skills, phaseTransition, riskLevel });
}
