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

  await new Promise((resolve) =>
    setTimeout(resolve, 1000 + Math.random() * 2000)
  );

  const reviewResults: Record<SkillType, { verdict: string; findings: string[] }> =
    {
      "plan-review": {
        verdict: "approved_with_notes",
        findings: [
          "Plan is clear and actionable.",
          "Consider adding error handling for edge case in step 3.",
          "Dependency on external API should be noted as a risk.",
        ],
      },
      "code-review": {
        verdict: "approved",
        findings: [
          "Code follows project conventions.",
          "Good test coverage for critical paths.",
          "Minor: consider extracting utility function for reuse.",
        ],
      },
      "security-review": {
        verdict: "approved_with_notes",
        findings: [
          "No critical vulnerabilities found.",
          "Recommendation: add rate limiting to new endpoint.",
          "Input validation present but could be stricter on email field.",
        ],
      },
      "architecture-review": {
        verdict: "needs_changes",
        findings: [
          "Coupling between auth and user modules is concerning.",
          "Consider using dependency injection for better testability.",
          "The proposed pattern may not scale beyond 10k requests/s.",
        ],
      },
    };

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

  const result = reviewResults[skillId] || {
    verdict: "approved",
    findings: ["No issues found."],
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
