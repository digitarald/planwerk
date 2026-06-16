export type Phase = "define" | "plan" | "build" | "verify" | "review" | "ship";
export type RuntimeStatus = "idle" | "running" | "input-needed" | "error";
export type GateStatus = "pending" | "evaluating" | "passed" | "failed";
export type AttentionLevel =
  | "none"
  | "needs-human"
  | "stale"
  | "error"
  | "conflict";
export type RiskLevel = "low" | "medium" | "high";

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
  { id: "verify", title: "Verify", description: "Running checks", wipLimit: 2 },
  { id: "review", title: "Review", description: "AI review" },
  { id: "ship", title: "Ship", description: "Ready to deliver" },
];
