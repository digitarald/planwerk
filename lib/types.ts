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

/**
 * Discriminates the kind of outstanding input surfaced from a session's
 * aggregated `SessionState.inputNeeded`:
 * - `elicitation` — a user-facing question (the default; answered via inputCompleted).
 * - `toolConfirmation` — a tool call awaiting approve/deny (before or after running).
 * - `toolExecution` — a running tool delegated to an active client. Planwerk provides
 *   no tools, so these are surfaced read-only as a blocker.
 */
export type PendingInputKind = "elicitation" | "toolConfirmation" | "toolExecution";

/** An approve/deny confirmation option offered by the host for a tool call. */
export interface ToolConfirmationOption {
  id: string;
  label: string;
  /** Whether choosing this option approves or denies the tool call. */
  intent: "approve" | "deny";
}

/** Details needed to render and answer a tool-call confirmation. */
export interface ToolConfirmationDetails {
  /** Owning chat channel URI the confirmation is dispatched to (server-derived). */
  chatUri: string;
  turnId: string;
  toolCallId: string;
  /** "param" confirms before execution; "result" confirms the produced result. */
  confirmKind: "param" | "result";
  /** Human-readable tool name, e.g. "Run in terminal". */
  toolName?: string;
  /** What the tool intends to do / what it produced. */
  intention?: string;
  /** Server-provided options; when present, render these instead of plain approve/deny. */
  options?: ToolConfirmationOption[];
}

export interface PendingInput {
  requestId: string;
  /** Top-level message for the input request (e.g. plan summary or question context) */
  message?: string;
  questions: PendingInputQuestion[];
  /** Discriminates elicitations from tool confirmations / execution blockers. Absent = elicitation. */
  kind?: PendingInputKind;
  /** Present when `kind === "toolConfirmation"`. */
  toolConfirmation?: ToolConfirmationDetails;
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
  /** Human-readable reason the card can't yet advance to the next phase, when
   *  `gateStatus` is otherwise silent (`pending`). Derived from the pending
   *  required gates + latest review-run state — e.g. "Plan review not started".
   *  Legibility only; never moves the card. */
  gateBlocker?: string;
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
  /** Board-level coherence: other in-flight cards this one clashes with. Set from
   *  DB rows in enrichment; only reviewer-confirmed conflicts populate this. */
  coherence?: CoherenceSummary;
}

export type CoherenceTier = "file" | "module";

export type CoherenceStatus =
  | "detected"
  | "reviewing"
  | "conflict"
  | "coherent"
  | "needs-human"
  | "dismissed";

/** A single peer card this card clashes with, for card/detail rendering. */
export interface CoherenceConflictPeer {
  cardId: string;
  cardTitle: string;
  tier: CoherenceTier;
  status: CoherenceStatus;
  summary?: string;
  findings?: string[];
  overlapPaths?: string[];
}

/** Card-attached coherence view. `blocking` is a display hint; enforcement always
 *  reads the DB rows via getShipBlockingConflicts, never this field. */
export interface CoherenceSummary {
  conflictsWith: CoherenceConflictPeer[];
  blocking: boolean;
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
