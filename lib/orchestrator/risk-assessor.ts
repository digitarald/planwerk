import { RiskLevel } from "@/lib/types";

export interface RiskInput {
  title: string;
  activity?: string;
  filesChanged: number;
  additions: number;
  deletions: number;
}

interface RiskFactors {
  fileCount: number;
  totalChanges: number;
  hasSecurityKeywords: boolean;
  hasDatabaseChanges: boolean;
  complexityScore: number;
}

const SECURITY_KEYWORDS = [
  "auth",
  "token",
  "password",
  "secret",
  "key",
  "credential",
  "permission",
  "role",
];
const DATABASE_KEYWORDS = [
  "migration",
  "schema",
  "database",
  "sql",
  "table",
  "index",
];

export function assessRisk(input: RiskInput): {
  level: RiskLevel;
  factors: string[];
} {
  const factors: string[] = [];
  let score = 0;

  const titleLower = input.title.toLowerCase();
  const activityLower = (input.activity || "").toLowerCase();
  const combined = `${titleLower} ${activityLower}`;
  const metrics: RiskFactors = {
    fileCount: input.filesChanged,
    totalChanges: input.additions + input.deletions,
    hasSecurityKeywords: SECURITY_KEYWORDS.some((kw) => combined.includes(kw)),
    hasDatabaseChanges: DATABASE_KEYWORDS.some((kw) => combined.includes(kw)),
    complexityScore:
      input.filesChanged > 10
        ? 2
        : input.filesChanged > 5
          ? 1
          : 0,
  };

  if (metrics.fileCount > 10) {
    score += 2;
    factors.push(`Large changeset (${metrics.fileCount} files)`);
  } else if (metrics.fileCount > 5) {
    score += 1;
    factors.push(`Moderate changeset (${metrics.fileCount} files)`);
  }

  if (metrics.totalChanges > 200) {
    score += 2;
    factors.push(`${metrics.totalChanges} lines changed`);
  } else if (metrics.totalChanges > 50) {
    score += 1;
  }

  if (metrics.hasSecurityKeywords) {
    score += 2;
    factors.push("Security-sensitive area");
  }

  if (metrics.hasDatabaseChanges) {
    score += 1;
    factors.push("Database changes");
  }

  let level: RiskLevel;
  if (score >= 4) {
    level = "high";
  } else if (score >= 2) {
    level = "medium";
  } else {
    level = "low";
  }

  return { level, factors };
}
