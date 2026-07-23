import {
  extractLastAgentMessage,
  type ResponsePartLike,
  type TurnWithResponsePartsLike,
} from "../ahp/response-parts.ts";

export interface ReviewEvidence {
  response: string | undefined;
  madeEdits: boolean;
}

const EDIT_TOOL_NAMES = new Set([
  "apply_patch",
  "create",
  "create_or_update_file",
  "delete_file",
  "edit",
  "insert",
  "push_files",
  "replace",
  "write_file",
]);

function isEditingToolCall(part: ResponsePartLike): boolean {
  if (part.kind !== "toolCall" || !("toolCall" in part)) return false;
  const toolCall = part.toolCall;
  if (!toolCall || typeof toolCall !== "object") return false;

  const toolName = (toolCall as { toolName?: unknown }).toolName;
  if (typeof toolName !== "string") return false;
  const normalized = toolName.toLowerCase().split(/[./]/).at(-1);
  return normalized !== undefined && EDIT_TOOL_NAMES.has(normalized);
}

export function extractReviewEvidence(
  turn: TurnWithResponsePartsLike
): ReviewEvidence {
  return {
    response: extractLastAgentMessage([turn], null),
    madeEdits: (turn.responseParts ?? []).some(isEditingToolCall),
  };
}
