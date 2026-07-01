export type Phase = "define" | "plan" | "build" | "review" | "ship";
export type RuntimeStatus = "idle" | "running" | "input-needed" | "error";
export type GateStatus = "pending" | "evaluating" | "passed" | "failed";
export type AttentionLevel =
  | "none"
  | "needs-human"
  | "stale"
  | "error"
  | "conflict";
export type RiskLevel = "low" | "medium" | "high";
export type ArtifactType = "plan" | "research" | "design" | "spec" | "test-plan" | "decision";
export type ArtifactStatus = "draft" | "approved" | "superseded";

export interface Artifact {
  id: string;
  type: ArtifactType;
  title: string;
  contentRef?: string;
  createdAt: number;
  createdBy: "human" | "agent";
  status: ArtifactStatus;
}

export interface ActivityEntry {
  timestamp: number;
  type: "tool" | "agent" | "gate";
  message: string;
}

/** A single recorded status (activity) line for a card, used to render the
 *  fading progress trail. Chronological order is oldest→newest; the last entry
 *  mirrors the card's current `activity`. */
export interface StatusEntry {
  message: string;
  timestamp: number;
}

export type PendingInputOptionKind = "text" | "number" | "boolean" | "single-select" | "multi-select";

export interface PendingInputOption {
  id: string;
  label: string;
  description?: string;
  recommended?: boolean;
}

export interface PendingInputQuestion {
  id: string;
  kind: PendingInputOptionKind;
  title?: string;
  message: string;
  required?: boolean;
  options?: PendingInputOption[];
  allowFreeform?: boolean;
  defaultValue?: string | number | boolean;
}

export interface PendingInput {
  requestId: string;
  /** Top-level message for the input request (e.g. plan summary or question context) */
  message?: string;
  questions: PendingInputQuestion[];
}

export interface FileChange {
  path: string;
  added: number;
  removed: number;
}

export interface KanbanCard {
  id: string;
  title: string;
  phase: Phase;
  runtime: RuntimeStatus;
  gateStatus: GateStatus;
  manualOverride?: boolean;
  attention: AttentionLevel;
  risk: RiskLevel;
  riskFactors?: string[];
  activity: string;
  additions: number;
  deletions: number;
  filesChanged: number;
  planSteps: { total: number; done: number };
  modifiedAt: number;
  model?: string;
  branch?: string;
  workingDirectory?: string;
  project?: { name: string; path: string };
  artifacts?: Artifact[];
  recentActivity?: ActivityEntry[];
  pendingInput?: PendingInput;
  lastAgentMessage?: string;
  fileChanges?: FileChange[];
  isArchived?: boolean;
  reviewFindings?: ReviewFinding[];
  /** Recent status lines (oldest→newest), for the fading progress trail. */
  statusHistory?: StatusEntry[];
}

export interface ReviewFinding {
  id: string;
  skillId: string;
  status: "passed" | "failed" | "escalated" | "in-progress";
  iteration: number;
  maxIterations: number;
  summary?: string;
  findings?: string[];
}

/** Client-safe view of a server GateRun record (from /api/gates/status).
 *  Mirrors the JSON shape emitted by gate-engine.mapGateRun. */
export interface GateRunView {
  id: number;
  cardId: string;
  fromPhase: Phase;
  toPhase: Phase;
  gateType: "lint" | "typecheck" | "test" | "review" | "human-approval" | "custom";
  gateName?: string;
  status: "running" | "passed" | "failed";
  output?: string;
  startedAt: string;
  completedAt?: string;
  changesetRef?: string;
}

/** The code-diff portion of a changeset ref (files:additions:deletions),
 *  ignoring the modifiedAt suffix so activity ticks don't read as code change. */
export function changesetCodeRef(card: {
  filesChanged: number;
  additions: number;
  deletions: number;
}): string {
  return `${card.filesChanged}:${card.additions}:${card.deletions}`;
}

/** Normalize a stored changeset ref to its code-diff portion
 *  (files:additions:deletions), dropping the trailing modifiedAt. Used as the
 *  single freshness signal shared by the UI and the gate engine. */
export function normalizeChangesetRef(ref?: string): string {
  if (!ref) return "";
  return ref.split(":").slice(0, 3).join(":");
}

/** A gate verdict is stale when it was recorded against a different code diff
 *  than the card currently shows. Compares only the diff dimensions. */
export function isGateRunStale(
  run: GateRunView,
  card: { filesChanged: number; additions: number; deletions: number }
): boolean {
  if (!run.changesetRef) return false;
  return normalizeChangesetRef(run.changesetRef) !== changesetCodeRef(card);
}

export interface Column {
  id: Phase;
  title: string;
  description: string;
  wipLimit?: number;
}

export const COLUMNS: Column[] = [
  { id: "define", title: "Define", description: "Idea being refined" },
  { id: "plan", title: "Plan", description: "Spec & plan" },
  { id: "build", title: "Build", description: "Writing code", wipLimit: 3 },
  { id: "review", title: "Review", description: "Code review & approval", wipLimit: 2 },
  { id: "ship", title: "Ship", description: "Ready to deliver" },
];

export const PHASE_ORDER: Phase[] = COLUMNS.map((col) => col.id);
