import type Database from "better-sqlite3";

import type { RiskLevel } from "../types.ts";
import {
  riskFactsStillMatch,
  type RiskFactsSnapshot,
} from "./risk-facts.ts";

export function setCardRiskInDb(
  db: Database.Database,
  cardId: string,
  level: RiskLevel,
  factors: string[],
  assessedBy: "copilot" | "human" | "rule" | "decision-model",
  riskDigest: string,
): void {
  db.prepare(
    `INSERT INTO card_risk (
       card_id, risk_level, risk_factors, assessed_at, assessed_by, risk_digest
     )
     VALUES (?, ?, ?, datetime('now'), ?, ?)
     ON CONFLICT(card_id) DO UPDATE SET
       risk_level = ?,
       risk_factors = ?,
       assessed_at = datetime('now'),
       assessed_by = ?,
       risk_digest = ?`
  ).run(
    cardId,
    level,
    JSON.stringify(factors),
    assessedBy,
    riskDigest,
    level,
    JSON.stringify(factors),
    assessedBy,
    riskDigest,
  );
}

export function setCardRiskIfFactsCurrent(
  db: Database.Database,
  snapshot: RiskFactsSnapshot,
  level: RiskLevel,
  factors: string[],
  assessedBy: "copilot" | "rule" | "decision-model" = "copilot",
  decision?: { key: string; policy: string },
): boolean {
  const persist = db.transaction(() => {
    if (!riskFactsStillMatch(db, snapshot)) return false;
    setCardRiskInDb(
      db,
      snapshot.cardId,
      level,
      factors,
      assessedBy,
      snapshot.digest,
    );
    if (decision) {
      db.prepare("UPDATE card_risk SET decision_key = ?, decision_policy = ? WHERE card_id = ?")
        .run(decision.key, decision.policy, snapshot.cardId);
    }
    return true;
  });
  return persist.immediate();
}
