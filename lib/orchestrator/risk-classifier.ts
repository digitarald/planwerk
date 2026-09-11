import type { RiskLevel } from "../types.ts";

export interface DeterministicRiskInput {
  title: string;
  activity?: string;
  filesChanged: number;
  additions: number;
  deletions: number;
  filePaths?: string[];
  lastAgentMessage?: string;
  planContent?: string;
  factsComplete?: boolean;
}

export interface DeterministicRiskAssessment {
  level: RiskLevel;
  factors: string[];
}

const HIGH_RISK_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  [/(?:^|[/_.-])auth(?:entication|orization)?(?:[/_.-]|$)|\bauth(?:entication|orization)?\b|\boauth\b|\bsso\b|\blogin\b|\bsession token\b/i, "Authentication-sensitive change"],
  [/(?:^|[/_.-])security(?:[/_.-]|$)|\bsecurity\b|\bcredential\b|\bsecret\b|\bencrypt(?:ion|ed)?\b|\bcrypto(?:graphy)?\b/i, "Security-sensitive change"],
  [/(?:^|[/_.-])permissions?(?:[/_.-]|$)|\baccess control\b|\bacl\b|\brbac\b|\bprivilege\b/i, "Permissions-sensitive change"],
  [/(?:^|[/_.-])migrations?(?:[/_.-]|$)|(?:^|[/_.-])schema(?:[/_.-]|$)|\bmigrations?\b|\bschema\b/i, "Schema or migration change"],
  [/\b(?:drop|truncate|wipe|purge|delete all|destroy|force[ -]?push|reset\s+--hard|rollback)\b|\b(?:delete|remove)\b.{0,40}\b(?:data|database|table|schema|record|file|directory|resource|account)\b/i, "Destructive operation"],
];

function evidenceText(input: DeterministicRiskInput): string {
  return [
    input.title,
    input.activity,
    ...(input.filePaths ?? []),
    input.planContent,
    input.lastAgentMessage,
  ].filter((value): value is string => typeof value === "string").join("\n");
}

export function classifyRiskDeterministically(
  input: DeterministicRiskInput,
): DeterministicRiskAssessment {
  if (input.factsComplete !== true) {
    return {
      level: "high",
      factors: ["Authoritative file facts are incomplete"],
    };
  }

  const evidence = evidenceText(input);
  const sensitive = HIGH_RISK_PATTERNS.find(([pattern]) => pattern.test(evidence));
  if (sensitive) {
    return { level: "high", factors: [sensitive[1]] };
  }

  const factors: string[] = [];
  let score = 0;
  if (input.filesChanged > 10) {
    score += 2;
    factors.push(`Large changeset (${input.filesChanged} files)`);
  } else if (input.filesChanged > 5) {
    score += 1;
    factors.push(`Moderate changeset (${input.filesChanged} files)`);
  }

  const totalChanges = input.additions + input.deletions;
  if (totalChanges > 200) {
    score += 2;
    factors.push(`${totalChanges} lines changed`);
  } else if (totalChanges > 50) {
    score += 1;
    factors.push(`${totalChanges} lines changed`);
  }

  const level: RiskLevel = score >= 3 ? "high" : score >= 1 ? "medium" : "low";
  if (factors.length === 0) factors.push("Small change with complete file facts");
  return { level, factors };
}

export function requiresConservativeHighRisk(
  input: DeterministicRiskInput,
): DeterministicRiskAssessment | null {
  const assessment = classifyRiskDeterministically(input);
  return assessment.level === "high" ? assessment : null;
}
