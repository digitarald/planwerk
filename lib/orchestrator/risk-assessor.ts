import { KanbanCard, RiskLevel } from "@/lib/types";

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

export function assessRisk(card: KanbanCard): {
  level: RiskLevel;
  factors: string[];
} {
  const factors: string[] = [];
  let score = 0;

  const titleLower = card.title.toLowerCase();
  const activityLower = (card.activity || "").toLowerCase();
  const combined = `${titleLower} ${activityLower}`;
  const metrics: RiskFactors = {
    fileCount: card.filesChanged,
    totalChanges: card.additions + card.deletions,
    hasSecurityKeywords: SECURITY_KEYWORDS.some((kw) => combined.includes(kw)),
    hasDatabaseChanges: DATABASE_KEYWORDS.some((kw) => combined.includes(kw)),
    complexityScore:
      card.filesChanged > 10
        ? 2
        : card.filesChanged > 5
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
