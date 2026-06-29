import "server-only";

import { getDb } from "@/lib/db/schema";
import { GateStatus, Phase, PHASE_ORDER, RiskLevel, normalizeChangesetRef } from "@/lib/types";

export type GateType =
  | "lint"
  | "typecheck"
  | "test"
  | "review"
  | "human-approval"
  | "custom";

export interface GateRun {
  id: number;
  cardId: string;
  fromPhase: Phase;
  toPhase: Phase;
  gateType: GateType;
  gateName?: string;
  status: "running" | "passed" | "failed";
  output?: string;
  startedAt: string;
  completedAt?: string;
  changesetRef?: string;
  stale?: boolean;
}

export interface GateConfig {
  phaseTransition: string;
  gateType: GateType;
  command?: string;
  gateName?: string;
  required: boolean;
  riskThreshold?: RiskLevel;
}

/**
 * Compute a changeset reference from card metrics.
 * Used to detect when source has changed since a gate last ran.
 */
export function computeChangesetRef(
  filesChanged: number,
  additions: number,
  deletions: number,
  modifiedAt: number
): string {
  return `${filesChanged}:${additions}:${deletions}:${modifiedAt}`;
}

const RISK_ORDER: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2 };

const DEFAULT_GATES: Record<string, GateConfig[]> = {
  "plan->build": [
    {
      phaseTransition: "plan->build",
      gateType: "review",
      gateName: "plan-review",
      required: true,
    },
    {
      phaseTransition: "plan->build",
      gateType: "review",
      gateName: "architecture-review",
      required: true,
      riskThreshold: "high",
    },
    {
      phaseTransition: "plan->build",
      gateType: "human-approval",
      gateName: "plan-approval",
      required: true,
      riskThreshold: "high",
    },
  ],
  "build->review": [
    {
      phaseTransition: "build->review",
      gateType: "lint",
      command: "npm run lint",
      required: true,
    },
    {
      phaseTransition: "build->review",
      gateType: "typecheck",
      command: "npm run typecheck",
      required: true,
    },
    {
      phaseTransition: "build->review",
      gateType: "test",
      command: "npm test",
      required: true,
      riskThreshold: "medium",
    },
  ],
  "review->ship": [
    {
      phaseTransition: "review->ship",
      gateType: "review",
      gateName: "code-review",
      required: true,
    },
    {
      phaseTransition: "review->ship",
      gateType: "review",
      gateName: "security-review",
      required: true,
      riskThreshold: "medium",
    },
    {
      phaseTransition: "review->ship",
      gateType: "human-approval",
      gateName: "ship-approval",
      required: true,
      riskThreshold: "high",
    },
  ],
};

type GateRunRow = {
  id: number;
  card_id: string;
  from_phase: string;
  to_phase: string;
  gate_type: string;
  gate_name: string | null;
  status: string;
  output: string | null;
  started_at: string;
  completed_at: string | null;
  changeset_ref: string | null;
};

function mapGateRun(row: GateRunRow): GateRun {
  return {
    id: row.id,
    cardId: row.card_id,
    fromPhase: row.from_phase as Phase,
    toPhase: row.to_phase as Phase,
    gateType: row.gate_type as GateType,
    gateName: row.gate_name || undefined,
    status: row.status as "running" | "passed" | "failed",
    output: row.output || undefined,
    startedAt: row.started_at,
    completedAt: row.completed_at || undefined,
    changesetRef: row.changeset_ref || undefined,
  };
}

function filterGatesByRisk(gates: GateConfig[], riskLevel?: RiskLevel): GateConfig[] {
  if (!riskLevel) {
    return gates;
  }

  const cardRisk = RISK_ORDER[riskLevel];
  return gates.filter((gate) => {
    if (!gate.riskThreshold) return true;
    return cardRisk >= RISK_ORDER[gate.riskThreshold];
  });
}

export function getGatesForTransition(
  fromPhase: Phase,
  toPhase: Phase,
  projectPath?: string,
  riskLevel?: RiskLevel
): GateConfig[] {
  const transition = `${fromPhase}->${toPhase}`;

  if (projectPath) {
    const db = getDb();
    const configs = db
      .prepare(
        "SELECT * FROM gate_configs WHERE project_path = ? AND phase_transition = ?"
      )
      .all(projectPath, transition) as Array<{
      phase_transition: string;
      gate_type: string;
      command: string | null;
      gate_name?: string | null;
      required: number;
      risk_threshold?: string | null;
    }>;

    if (configs.length > 0) {
      return filterGatesByRisk(
        configs.map((config) => ({
          phaseTransition: config.phase_transition,
          gateType: config.gate_type as GateType,
          command: config.command || undefined,
          gateName: config.gate_name || undefined,
          required: Boolean(config.required),
          riskThreshold: config.risk_threshold as RiskLevel | undefined,
        })),
        riskLevel
      );
    }
  }

  return filterGatesByRisk(DEFAULT_GATES[transition] || [], riskLevel);
}

export function startGateRun(
  cardId: string,
  fromPhase: Phase,
  toPhase: Phase,
  gateType: GateType,
  gateName?: string,
  changesetRef?: string
): number {
  const db = getDb();
  db.prepare(
    "INSERT OR IGNORE INTO card_phases (card_id, phase, updated_at) VALUES (?, ?, datetime('now'))"
  ).run(cardId, fromPhase);

  const result = db
    .prepare(
      "INSERT INTO gate_runs (card_id, from_phase, to_phase, gate_type, gate_name, changeset_ref) VALUES (?, ?, ?, ?, ?, ?)"
    )
    .run(cardId, fromPhase, toPhase, gateType, gateName || null, changesetRef || null);

  return Number(result.lastInsertRowid);
}

export function completeGateRun(
  runId: number,
  status: "passed" | "failed",
  output?: string
): void {
  const db = getDb();
  db.prepare(
    "UPDATE gate_runs SET status = ?, output = ?, completed_at = datetime('now') WHERE id = ?"
  ).run(status, output || null, runId);
}

export function getGateRunsForCard(cardId: string): GateRun[] {
  const db = getDb();
  const rows = db
    .prepare("SELECT * FROM gate_runs WHERE card_id = ? ORDER BY started_at DESC")
    .all(cardId) as GateRunRow[];

  return rows.map(mapGateRun);
}

export function getLatestPassingRuns(
  cardId: string,
  fromPhase: Phase,
  toPhase: Phase,
  currentChangesetRef?: string
): GateRun[] {
  const db = getDb();
  const rows = db
    .prepare(
      `
        SELECT * FROM gate_runs
        WHERE card_id = ? AND from_phase = ? AND to_phase = ? AND status = 'passed'
        ORDER BY completed_at DESC
      `
    )
    .all(cardId, fromPhase, toPhase) as GateRunRow[];

  return rows.map((row) => {
    const run = mapGateRun(row);
    // Mark as stale if the *code* changed since the gate ran. Compare only the
    // diff dimensions (files:additions:deletions) — the same normalized signal
    // the UI uses — so activity-only modifiedAt ticks don't invalidate a verdict.
    if (
      currentChangesetRef &&
      normalizeChangesetRef(run.changesetRef) !== normalizeChangesetRef(currentChangesetRef)
    ) {
      run.stale = true;
    }
    return run;
  });
}

export function canAdvancePhase(
  cardId: string,
  fromPhase: Phase,
  toPhase: Phase,
  projectPath?: string,
  riskLevel?: RiskLevel,
  changesetRef?: string
): { allowed: boolean; pendingGates: GateConfig[] } {
  const gates = getGatesForTransition(fromPhase, toPhase, projectPath, riskLevel);
  const requiredGates = gates.filter((gate) => gate.required);

  if (requiredGates.length === 0) {
    return { allowed: true, pendingGates: [] };
  }

  const passingRuns = getLatestPassingRuns(cardId, fromPhase, toPhase, changesetRef);
  // Exclude stale runs — they don't count toward advancement
  const freshRuns = passingRuns.filter((run) => !run.stale);
  const pendingGates = requiredGates.filter((gate) => {
    if (gate.gateName) {
      return !freshRuns.some(
        (run) => run.gateType === gate.gateType && run.gateName === gate.gateName
      );
    }

    return !freshRuns.some((run) => run.gateType === gate.gateType);
  });

  return {
    allowed: pendingGates.length === 0,
    pendingGates,
  };
}

export function getPersistedCardPhase(cardId: string): Phase | undefined {
  const db = getDb();
  const row = db
    .prepare("SELECT phase FROM card_phases WHERE card_id = ?")
    .get(cardId) as { phase: string } | undefined;
  if (!row) return undefined;
  const phase = row.phase;
  if (phase === "verify") return "review";
  return phase as Phase;
}

/** Batch read of persisted phases for the given cards. Cards with no stored
 *  transition are omitted so callers keep their AHP-derived phase. */
export function getPersistedPhases(cardIds: string[]): Record<string, Phase> {
  if (cardIds.length === 0) return {};
  const db = getDb();
  const placeholders = cardIds.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT card_id, phase FROM card_phases WHERE card_id IN (${placeholders})`
    )
    .all(...cardIds) as Array<{ card_id: string; phase: string }>;

  const result: Record<string, Phase> = {};
  for (const row of rows) {
    result[row.card_id] = (row.phase === "verify" ? "review" : row.phase) as Phase;
  }
  return result;
}

/** Durable audit entry when a human forces a phase move past gates via DnD. */
export function logManualOverride(
  cardId: string,
  fromPhase: Phase,
  toPhase: Phase,
  direction: "forward" | "backward"
): void {
  const db = getDb();
  db.prepare(
    "INSERT INTO heartbeat_log (detection, card_id, action_taken, detail) VALUES (?, ?, ?, ?)"
  ).run(
    "manual-override",
    cardId,
    direction === "forward" ? "phase-forced" : "phase-reworked",
    `${fromPhase}->${toPhase}`
  );
}

export function deriveGateStatus(
  cardId: string,
  fromPhase: Phase,
  toPhase: Phase,
  riskLevel?: RiskLevel
): GateStatus {
  const gates = getGatesForTransition(fromPhase, toPhase, undefined, riskLevel);
  const requiredGates = gates.filter((g) => g.required);
  if (requiredGates.length === 0) return "pending";

  const runs = getGateRunsForCard(cardId);
  const relevantRuns = runs.filter((r) => r.fromPhase === fromPhase && r.toPhase === toPhase);

  if (relevantRuns.some((r) => r.status === "failed")) return "failed";
  if (relevantRuns.some((r) => r.status === "running")) return "evaluating";

  const { allowed } = canAdvancePhase(cardId, fromPhase, toPhase, undefined, riskLevel);
  return allowed ? "passed" : "pending";
}

export function getCardPhase(cardId: string): Phase {
  const db = getDb();
  const row = db
    .prepare("SELECT phase FROM card_phases WHERE card_id = ?")
    .get(cardId) as { phase: string } | undefined;

  const phase = row?.phase || "define";
  if (phase === "verify") return "review";
  return phase as Phase;
}

export function setCardPhase(cardId: string, phase: Phase): void {
  const db = getDb();
  db.prepare(
    `
      INSERT INTO card_phases (card_id, phase, updated_at)
      VALUES (?, ?, datetime('now'))
      ON CONFLICT(card_id) DO UPDATE SET phase = ?, updated_at = datetime('now')
    `
  ).run(cardId, phase, phase);
}

export function getNextPhase(current: Phase): Phase | null {
  const index = PHASE_ORDER.indexOf(current);

  if (index === -1 || index === PHASE_ORDER.length - 1) {
    return null;
  }

  return PHASE_ORDER[index + 1];
}
