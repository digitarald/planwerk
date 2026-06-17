export interface AHPSessionSummary {
  resource: string;
  provider: string;
  title: string;
  status: number;
  activity?: string;
  createdAt: string;
  modifiedAt: string;
  project?: {
    name: string;
    path: string;
  };
  model?: string;
  agent?: string;
  workingDirectory?: string;
  changes?: {
    additions: number;
    deletions: number;
    files: number;
  };
  annotations?: Array<{
    title: string;
    description?: string;
    kind?: string;
  }>;
}

export const AHPStatus = {
  Idle: 1,
  Error: 2,
  InProgress: 8,
  InputNeeded: 24,
  IsRead: 32,
  IsArchived: 64,
} as const;

export function parseAHPStatus(status: number) {
  return {
    isIdle: (status & AHPStatus.Idle) !== 0,
    isError: (status & AHPStatus.Error) !== 0,
    // InputNeeded (24) is composite and includes InProgress (8)
    isInProgress: (status & AHPStatus.InProgress) !== 0,
    isInputNeeded: (status & AHPStatus.InputNeeded) === AHPStatus.InputNeeded,
    isRead: (status & AHPStatus.IsRead) !== 0,
    isArchived: (status & AHPStatus.IsArchived) !== 0,
  };
}

export type AHPEvent =
  | { type: "sessionAdded"; session: AHPSessionSummary }
  | { type: "sessionRemoved"; resource: string }
  | { type: "sessionSummaryChanged"; session: AHPSessionSummary };
