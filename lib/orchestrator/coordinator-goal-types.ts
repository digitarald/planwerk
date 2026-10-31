export type GoalState = "draft" | "active" | "paused" | "needs-human" | "completed" | "cancelled";
export type WorkState = "ready" | "dispatched" | "queued" | "awaiting-result" | "blocked" | "completed" | "failed" | "uncertain";

export interface GoalWorkItem {
  id: string;
  goalId: string;
  instructions: string;
  acceptanceCriteria: string;
  workingDirectory: string;
  cardId?: string;
  state: WorkState;
  actionKey: string;
  baseline?: string;
  delivery?: { chatUri?: string; turnId?: string; pendingMessageId?: string; messageId?: string; queued?: boolean; resource?: string };
  outcome?: string;
  evidence?: { digest: string; sourceRevision?: string; planContentHash?: string; accepted: boolean; verified: boolean; observedAt: string };
  dependencies: { itemId: string; kind: "result" | "verified" }[];
}

export interface CoordinatorGoal {
  id: string;
  hostUrl: string;
  workspaceScope: string[];
  objective: string;
  acceptanceCriteria: string;
  state: GoalState;
  revision: number;
  summary?: string;
  evidenceDigest?: string;
  items: GoalWorkItem[];
}
