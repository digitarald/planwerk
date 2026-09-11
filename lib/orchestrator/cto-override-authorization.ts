import type Database from "better-sqlite3";

import type {
  CtoApprovalBinding,
  CtoContinuityStore,
} from "../db/cto-continuity-store";
import { approvalBinding } from "./cto-approval.ts";
import { readAuthoritativeRisk } from "./risk-authority.ts";

type AuthoritativeCardRow = {
  phase: string;
  phase_updated_at: string;
};

export function getAuthoritativeApprovalBinding(
  toolName: string,
  args: Record<string, unknown>,
  sdkSessionId: string,
  db: Database.Database
): CtoApprovalBinding | null {
  const cardId = typeof args.cardId === "string" ? args.cardId : undefined;
  if (!cardId) return null;
  const row = db.prepare(`
    SELECT phase, updated_at AS phase_updated_at
    FROM card_phases
    WHERE card_id = ?
  `).get(cardId) as Pick<
    AuthoritativeCardRow,
    "phase" | "phase_updated_at"
  > | undefined;
  const risk = readAuthoritativeRisk(db, cardId);
  if (!row || risk.status !== "current") return null;
  const assessment = risk.assessment;
  return approvalBinding(toolName, args, sdkSessionId, assessment.level, {
    phase: row.phase,
    phaseUpdatedAt: row.phase_updated_at,
    risk: assessment.level,
    riskFactors: assessment.factors,
    riskAssessedAt: assessment.assessedAt,
    riskAssessedBy: assessment.assessedBy,
    riskDigest: risk.currentDigest,
  });
}

export type OverrideAuthorization =
  | { authorized: true; binding: CtoApprovalBinding }
  | { authorized: false; reason: string };

export function authorizeAndRunOverride(options: {
  db: Database.Database;
  store: CtoContinuityStore;
  args: Record<string, unknown>;
  sdkSessionId: string;
  toolCallId: string;
  mutate(): void;
}): OverrideAuthorization {
  const { db, store, args, sdkSessionId, toolCallId, mutate } = options;
  const transaction = db.transaction((): OverrideAuthorization => {
    const binding = getAuthoritativeApprovalBinding(
      "override_phase",
      args,
      sdkSessionId,
      db
    );
    if (!binding) {
      return {
        authorized: false,
        reason:
          "A persisted server-side risk assessment and phase are required.",
      };
    }
    if (
      binding.riskLevel === "high" &&
      !store.hasConsumedApproval(binding, toolCallId)
    ) {
      return {
        authorized: false,
        reason: "A current, matching human approval is required.",
      };
    }
    mutate();
    return { authorized: true, binding };
  });
  return transaction.immediate();
}
