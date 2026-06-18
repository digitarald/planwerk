import "server-only";

import { getDb } from "@/lib/db/schema";
import { RiskLevel } from "@/lib/types";

export interface StoredRisk {
  cardId: string;
  level: RiskLevel;
  factors: string[];
  assessedAt: string;
  assessedBy: "copilot" | "human";
}

interface RiskRow {
  card_id: string;
  risk_level: string;
  risk_factors: string;
  assessed_at: string;
  assessed_by: string;
}

function mapRow(row: RiskRow): StoredRisk {
  return {
    cardId: row.card_id,
    level: row.risk_level as RiskLevel,
    factors: JSON.parse(row.risk_factors),
    assessedAt: row.assessed_at,
    assessedBy: row.assessed_by as "copilot" | "human",
  };
}

export function getCardRisk(cardId: string): StoredRisk | undefined {
  const db = getDb();
  const row = db
    .prepare("SELECT * FROM card_risk WHERE card_id = ?")
    .get(cardId) as RiskRow | undefined;

  return row ? mapRow(row) : undefined;
}

export function setCardRisk(
  cardId: string,
  level: RiskLevel,
  factors: string[],
  assessedBy: "copilot" | "human" = "copilot"
): void {
  const db = getDb();
  db.prepare("INSERT OR IGNORE INTO card_phases (card_id) VALUES (?)").run(cardId);
  db.prepare(
    `INSERT INTO card_risk (card_id, risk_level, risk_factors, assessed_at, assessed_by)
     VALUES (?, ?, ?, datetime('now'), ?)
     ON CONFLICT(card_id) DO UPDATE SET
       risk_level = ?,
       risk_factors = ?,
       assessed_at = datetime('now'),
       assessed_by = ?`
  ).run(
    cardId,
    level,
    JSON.stringify(factors),
    assessedBy,
    level,
    JSON.stringify(factors),
    assessedBy
  );
}
