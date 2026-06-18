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

export interface KanbanCard {
  id: string;
  title: string;
  phase: Phase;
  runtime: RuntimeStatus;
  gateStatus: GateStatus;
  manualOverride?: boolean;
  attention: AttentionLevel;
  risk: RiskLevel;
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
  isArchived?: boolean;
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
