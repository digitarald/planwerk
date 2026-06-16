export type SkillType =
  | "plan-review"
  | "code-review"
  | "security-review"
  | "architecture-review";

export interface Skill {
  id: SkillType;
  name: string;
  description: string;
  triggerPhases: string[];
  riskThreshold: "low" | "medium" | "high";
  estimatedDuration: string;
}

export const SKILLS: Skill[] = [
  {
    id: "plan-review",
    name: "Adversarial Plan Review",
    description:
      "Challenges assumptions, identifies gaps, and stress-tests the plan before implementation begins.",
    triggerPhases: ["plan->build"],
    riskThreshold: "low",
    estimatedDuration: "~30s",
  },
  {
    id: "code-review",
    name: "Code Quality Review",
    description:
      "Reviews implementation for correctness, maintainability, and adherence to project conventions.",
    triggerPhases: ["review->ship"],
    riskThreshold: "low",
    estimatedDuration: "~45s",
  },
  {
    id: "security-review",
    name: "Security Review",
    description:
      "Scans for vulnerabilities, injection risks, auth issues, and sensitive data exposure.",
    triggerPhases: ["review->ship"],
    riskThreshold: "medium",
    estimatedDuration: "~60s",
  },
  {
    id: "architecture-review",
    name: "Architecture Review",
    description:
      "Evaluates design decisions, coupling, scalability concerns, and alignment with system architecture.",
    triggerPhases: ["plan->build"],
    riskThreshold: "high",
    estimatedDuration: "~90s",
  },
];

export function getSkillsForTransition(
  phaseTransition: string,
  riskLevel: "low" | "medium" | "high"
): Skill[] {
  const riskOrder = { low: 0, medium: 1, high: 2 };
  const cardRisk = riskOrder[riskLevel];

  return SKILLS.filter((skill) => {
    if (!skill.triggerPhases.includes(phaseTransition)) {
      return false;
    }

    const skillThreshold = riskOrder[skill.riskThreshold];
    return cardRisk >= skillThreshold;
  });
}
