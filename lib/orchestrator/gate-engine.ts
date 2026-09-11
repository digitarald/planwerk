import "server-only";

import { exec } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";

import { getDb } from "@/lib/db/schema";
import {
  PHASE_ORDER,
  normalizeChangesetRef,
  type ArtifactType,
  type GateStatus,
  type Phase,
  type RiskLevel,
} from "@/lib/types";
import { resolveGateWorkingDirectory } from "./gate-command";
import { loadConfig, type GateRef } from "./skill-config";
import { throwIfAborted } from "@/lib/abort";
import { WORK_LEASE_MS } from "@/lib/db/work-lease-schema";

export type GateType =
  | "lint"
  | "typecheck"
  | "test"
  | "review"
  | "artifact"
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
  artifactType?: ArtifactType;
  required: boolean;
  riskThreshold?: RiskLevel;
}

export interface ResolveConfiguredGateOptions {
  fromPhase: Phase;
  toPhase: Phase;
  gateType: GateType;
  gateName?: string;
  projectPath?: string;
  riskLevel?: RiskLevel;
}

export type ConfiguredGateResolution =
  | { ok: true; gate: GateConfig }
  | { ok: false; reason: string };

export interface StartGateRunOptions {
  cardId: string;
  fromPhase: Phase;
  toPhase: Phase;
  gateType: GateType;
  gateName?: string;
  changesetRef?: string;
  signal?: AbortSignal;
  ownerId?: string;
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

function scriptGateType(name: string): GateType {
  switch (name.trim().toLowerCase()) {
    case "lint":
      return "lint";
    case "type check":
    case "typecheck":
      return "typecheck";
    case "test":
    case "tests":
      return "test";
    default:
      return "custom";
  }
}

function configRefToGate(
  ref: GateRef,
  transition: string,
  required: boolean,
  scripts: Record<string, string>
): GateConfig {
  if (ref.type === "script") {
    return {
      phaseTransition: transition,
      gateType: scriptGateType(ref.name),
      gateName: ref.name,
      command: scripts[ref.name],
      required,
    };
  }
  if (ref.type === "artifact") {
    return {
      phaseTransition: transition,
      gateType: "artifact",
      gateName: ref.artifact,
      artifactType: ref.artifact,
      required,
    };
  }
  return {
    phaseTransition: transition,
    gateType: "review",
    gateName: ref.skill,
    required,
    riskThreshold: ref.riskThreshold,
  };
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

  const config = loadConfig(projectPath);
  const transitionConfig =
    config.gates[transition.replace("->", "-to-")] ?? config.gates[transition];
  if (!transitionConfig) return [];

  const gates = [
    ...transitionConfig.required.map((ref) =>
      configRefToGate(ref, transition, true, config.scripts)
    ),
    ...transitionConfig.optional.map((ref) =>
      configRefToGate(ref, transition, false, config.scripts)
    ),
  ];
  return filterGatesByRisk(gates, riskLevel);
}

export function resolveConfiguredGate({
  fromPhase,
  toPhase,
  gateType,
  gateName,
  projectPath,
  riskLevel,
}: ResolveConfiguredGateOptions): ConfiguredGateResolution {
  const candidates = getGatesForTransition(
    fromPhase,
    toPhase,
    projectPath,
    riskLevel,
  ).filter((gate) => gate.gateType === gateType);

  if (gateName !== undefined) {
    const gate = candidates.find((candidate) => candidate.gateName === gateName);
    return gate
      ? { ok: true, gate }
      : {
          ok: false,
          reason: `No configured gate matches type "${gateType}" name "${gateName}"`,
        };
  }

  if (candidates.length === 1) {
    return { ok: true, gate: candidates[0] };
  }
  if (candidates.length === 0) {
    return {
      ok: false,
      reason: `No configured gate matches type "${gateType}"`,
    };
  }

  return {
    ok: false,
    reason:
      `Multiple configured gates match type "${gateType}"; ` +
      "a configured gate name is required",
  };
}

export function startGateRun({
  cardId,
  fromPhase,
  toPhase,
  gateType,
  gateName,
  changesetRef,
  signal,
  ownerId = randomUUID(),
}: StartGateRunOptions): number {
  throwIfAborted(signal);
  const db = getDb();
  throwIfAborted(signal);
  db.prepare(
    "INSERT OR IGNORE INTO card_phases (card_id, phase, updated_at) VALUES (?, ?, datetime('now'))"
  ).run(cardId, fromPhase);

  throwIfAborted(signal);
  const result = db
    .prepare(
      `INSERT INTO gate_runs (
        card_id, from_phase, to_phase, gate_type, gate_name, changeset_ref,
        owner_id, lease_expires_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      cardId,
      fromPhase,
      toPhase,
      gateType,
      gateName || null,
      changesetRef || null,
      ownerId,
      Date.now() + WORK_LEASE_MS,
    );

  const runId = Number(result.lastInsertRowid);
  gateRunOwners.set(runId, ownerId);
  return runId;
}

const gateRunOwners = new Map<number, string>();

export function completeGateRun(
  runId: number,
  status: "passed" | "failed",
  output?: string
): boolean {
  const db = getDb();
  const ownerId = gateRunOwners.get(runId);
  const result = ownerId
    ? db.prepare(`
        UPDATE gate_runs
        SET status = ?, output = ?, completed_at = datetime('now'),
            lease_expires_at_ms = NULL
        WHERE id = ? AND status = 'running' AND owner_id = ?
          AND lease_expires_at_ms > ?
      `).run(status, output || null, runId, ownerId, Date.now())
    : db.prepare(`
        UPDATE gate_runs
        SET status = ?, output = ?, completed_at = datetime('now'),
            lease_expires_at_ms = NULL
        WHERE id = ? AND status = 'running' AND owner_id IS NULL
      `).run(status, output || null, runId);
  gateRunOwners.delete(runId);
  return result.changes === 1;
}

const GATE_MAX_OUTPUT = 64 * 1024;
const GATE_TIMEOUT_MS = 5 * 60_000;

/**
 * Execute a gate command asynchronously and complete the run on exit.
 * Validates the working directory up front: a missing/invalid cwd otherwise
 * surfaces from `exec` as a cryptic "spawn /bin/sh ENOENT", so we fail fast with
 * a clear, actionable message instead. Shared by the heartbeat and the manual
 * gate-run API so both behave identically.
 */
export function executeGateCommand(
  runId: number,
  command: string,
  cwd: string,
  onComplete?: (status: "passed" | "failed") => void,
): void {
  const complete = (status: "passed" | "failed", output: string): void => {
    clearInterval(renewalTimer);
    if (completeGateRun(runId, status, output)) onComplete?.(status);
  };
  const ownerId = gateRunOwners.get(runId);
  const renewalTimer = setInterval(() => {
    if (!ownerId) return;
    const now = Date.now();
    const renewed = getDb().prepare(`
      UPDATE gate_runs
      SET lease_expires_at_ms = ?
      WHERE id = ? AND status = 'running' AND owner_id = ?
        AND lease_expires_at_ms > ?
    `).run(now + WORK_LEASE_MS, runId, ownerId, now);
    if (renewed.changes !== 1) clearInterval(renewalTimer);
  }, Math.max(1, Math.floor(WORK_LEASE_MS / 3)));
  renewalTimer.unref();

  let resolvedCwd: string;
  try {
    resolvedCwd = resolveGateWorkingDirectory(cwd);
  } catch (error) {
    const detail = error instanceof Error ? ` (${error.message})` : "";
    complete("failed", `Invalid working directory: ${cwd}${detail}`);
    return;
  }

  let cwdOk = false;
  try {
    cwdOk = existsSync(resolvedCwd) && statSync(resolvedCwd).isDirectory();
  } catch {
    cwdOk = false;
  }

  if (!cwdOk) {
    complete("failed", `Working directory not found: ${resolvedCwd}`);
    return;
  }

  try {
    exec(
      command,
      { cwd: resolvedCwd, timeout: GATE_TIMEOUT_MS, maxBuffer: GATE_MAX_OUTPUT },
      (error, stdout, stderr) => {
        if (error) {
          const output = (stderr || stdout || error.message).slice(0, GATE_MAX_OUTPUT);
          complete("failed", output);
        } else {
          const output = (stdout || "All checks passed").slice(0, GATE_MAX_OUTPUT);
          complete("passed", output);
        }
      }
    );
  } catch (err) {
    complete(
      "failed",
      err instanceof Error ? err.message : "Failed to start gate command"
    );
  }
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

  const normalizedCurrent = normalizeChangesetRef(currentChangesetRef);

  return rows.map((row) => {
    const run = mapGateRun(row);
    // Evidence is fresh only when both sides carry the same non-empty revision.
    // Unknown current facts must never revive a verdict from an older source.
    if (
      normalizedCurrent === "" ||
      normalizeChangesetRef(run.changesetRef) === "" ||
      normalizeChangesetRef(run.changesetRef) !== normalizedCurrent
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

  // Advancement is revision-bound even when a transition has no configured
  // gates. Callers must establish the authoritative current source/plan first.
  if (normalizeChangesetRef(changesetRef) === "") {
    return { allowed: false, pendingGates: requiredGates };
  }

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
  riskLevel?: RiskLevel,
  changesetRef?: string,
  projectPath?: string
): GateStatus {
  const gates = getGatesForTransition(fromPhase, toPhase, projectPath, riskLevel);
  const requiredGates = gates.filter((g) => g.required);
  if (requiredGates.length === 0) return "pending";

  const runs = getGateRunsForCard(cardId);
  const relevantRuns = runs.filter((r) => r.fromPhase === fromPhase && r.toPhase === toPhase);

  if (relevantRuns.some((r) => r.status === "failed")) return "failed";
  if (relevantRuns.some((r) => r.status === "running")) return "evaluating";

  const { allowed } = canAdvancePhase(
    cardId,
    fromPhase,
    toPhase,
    projectPath,
    riskLevel,
    changesetRef
  );
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
