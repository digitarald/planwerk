import type { InboxItemKind } from "./types.ts";

export type InboxSessionState =
  | { type: "missing" | "disabled" | "archived" }
  | { type: "active"; needsInput: boolean; hasError: boolean };

type RetirementReason = "missing" | "disabled" | "archived" | "input-cleared" | "error-cleared";

const RETIRES_ON_ARCHIVE: Record<InboxItemKind, boolean> = {
  "pending-input": true,
  "runtime-error": true,
  "review-ready": true,
  "ship-ready": true,
  "gate-failure": true,
  "review-escalation": true,
  completion: false,
  conflict: false,
  "coordinator-action": false,
};

export function sessionRetirementReason(
  kind: InboxItemKind,
  state: InboxSessionState,
): RetirementReason | undefined {
  switch (state.type) {
    case "missing":
    case "disabled":
      return state.type;
    case "archived":
      return RETIRES_ON_ARCHIVE[kind] ? "archived" : undefined;
    case "active":
      if (kind === "pending-input" && !state.needsInput) return "input-cleared";
      if (kind === "runtime-error" && !state.hasError) return "error-cleared";
      return undefined;
  }
}
