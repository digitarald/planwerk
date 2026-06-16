import { NextRequest, NextResponse } from "next/server";

import {
  getSkillsForTransition,
  type SkillType,
} from "@/lib/orchestrator/skills";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const { cardId, skillId, phaseTransition, riskLevel } = (await request.json()) as {
    cardId?: string;
    skillId?: SkillType;
    phaseTransition?: string;
    riskLevel?: "low" | "medium" | "high";
  };

  if (!cardId || !skillId) {
    return NextResponse.json(
      { error: "cardId and skillId required" },
      { status: 400 }
    );
  }

  const availableSkills =
    phaseTransition && riskLevel
      ? getSkillsForTransition(phaseTransition, riskLevel)
      : null;

  if (availableSkills && !availableSkills.some((skill) => skill.id === skillId)) {
    return NextResponse.json(
      {
        error: "skillId is not valid for the given transition and risk level",
      },
      { status: 400 }
    );
  }

  const result = {
    verdict: "not_implemented" as const,
    findings: [
      `Review skill "${skillId}" is not yet connected to a real analysis engine.`,
      "This will be backed by LLM-powered code review in a future update.",
    ],
  };

  return NextResponse.json({
    cardId,
    skillId,
    phaseTransition: phaseTransition ?? null,
    riskLevel: riskLevel ?? null,
    ...result,
    completedAt: new Date().toISOString(),
  });
}

export async function GET(request: NextRequest) {
  const phaseTransition =
    request.nextUrl.searchParams.get("transition") || "plan->build";
  const riskLevel = (request.nextUrl.searchParams.get("risk") ||
    "medium") as "low" | "medium" | "high";

  const skills = getSkillsForTransition(phaseTransition, riskLevel);

  return NextResponse.json({ skills, phaseTransition, riskLevel });
}
