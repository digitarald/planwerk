export interface PendingGateLike {
  gateType: string;
  gateName?: string;
}

export interface SkillLike {
  id: string;
}

export function selectPendingReviewSkills<T extends SkillLike>(
  pendingGates: PendingGateLike[],
  configuredSkills: T[],
): {
  skills: T[];
  missingReviewNames: string[];
  nonReviewNames: string[];
} {
  const reviewNames = new Set(
    pendingGates
      .filter((gate) => gate.gateType === "review" && gate.gateName)
      .map((gate) => gate.gateName as string),
  );
  const skills = configuredSkills.filter((skill) => reviewNames.has(skill.id));
  const resolved = new Set(skills.map((skill) => skill.id));

  return {
    skills,
    missingReviewNames: [...reviewNames].filter((name) => !resolved.has(name)),
    nonReviewNames: pendingGates
      .filter((gate) => gate.gateType !== "review")
      .map((gate) => gate.gateName ?? gate.gateType),
  };
}
