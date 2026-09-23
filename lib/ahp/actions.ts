import type {
  ChatTurnStartedAction,
  ChatPendingMessageSetAction,
  ChatInputAnswerChangedAction,
  ChatInputCompletedAction,
  ChatInputAnswer,
  ChatTurnResumeAction,
  ChatToolCallConfirmedAction,
  ChatToolCallApprovedAction,
  ChatToolCallDeniedAction,
  ChatToolCallResultConfirmedAction,
  SessionIsArchivedChangedAction,
  Message,
  MessageOrigin,
} from "@microsoft/agent-host-protocol";

/**
 * Typed builders for the AHP `chat/*` actions Planwerk dispatches.
 *
 * The action `type`/`kind`/`response` discriminants are ambient `const enum`
 * members, which can't be referenced as values under `isolatedModules`. We
 * therefore cast the string literals to the corresponding indexed-access types
 * here, in one place. Every other field is fully type-checked against the SDK's
 * action interfaces, so a future protocol field rename breaks the build.
 */

const USER_ORIGIN = { kind: "user" } as MessageOrigin;

function userMessage(text: string): Message {
  return { text, origin: USER_ORIGIN };
}

/** Start a new turn with a user message (idle session). */
export function chatTurnStarted(
  turnId: string,
  text: string,
  startedAt: string = new Date().toISOString(),
): ChatTurnStartedAction {
  return {
    type: "chat/turnStarted" as ChatTurnStartedAction["type"],
    turnId,
    message: userMessage(text),
    startedAt,
  };
}

/** Queue a user message for delivery after the current turn finishes. */
export function chatQueuedMessage(id: string, text: string): ChatPendingMessageSetAction {
  return {
    type: "chat/pendingMessageSet" as ChatPendingMessageSetAction["type"],
    kind: "queued" as ChatPendingMessageSetAction["kind"],
    id,
    message: userMessage(text),
  };
}

/** Resume the latest errored turn after its identity and resumability are re-read. */
export function chatTurnResume(turnId: string): ChatTurnResumeAction {
  return {
    type: "chat/turnResume" as ChatTurnResumeAction["type"],
    turnId,
  };
}

/** Update the draft answer for a single question in an input request. */
export function chatInputAnswerChanged(
  requestId: string,
  questionId: string,
  answer: unknown,
): ChatInputAnswerChangedAction {
  return {
    type: "chat/inputAnswerChanged" as ChatInputAnswerChangedAction["type"],
    requestId,
    questionId,
    // Answer values originate from the HTTP request body (trust boundary).
    answer: answer as ChatInputAnswer,
  };
}

/** Complete an input request with the user's response. */
export function chatInputCompleted(
  requestId: string,
  response: "accept" | "decline" | "cancel",
  answers?: Record<string, unknown>,
): ChatInputCompletedAction {
  const action: ChatInputCompletedAction = {
    type: "chat/inputCompleted" as ChatInputCompletedAction["type"],
    requestId,
    response: response as ChatInputCompletedAction["response"],
  };
  if (answers) {
    action.answers = answers as Record<string, ChatInputAnswer>;
  }
  return action;
}

/** Archive or unarchive a session (session-level action, dispatched on the session URI). */
export function sessionIsArchivedChanged(isArchived: boolean): SessionIsArchivedChangedAction {
  return {
    type: "session/isArchivedChanged" as SessionIsArchivedChangedAction["type"],
    isArchived,
  };
}

/**
 * Approve or deny a tool call awaiting *parameter* confirmation (before it runs).
 * Dispatched to the owning chat channel. `selectedOptionId` is set when the host
 * offered explicit confirmation options.
 */
export function chatToolCallConfirmed(params: {
  turnId: string;
  toolCallId: string;
  approved: boolean;
  selectedOptionId?: string;
}): ChatToolCallConfirmedAction {
  const { turnId, toolCallId, approved, selectedOptionId } = params;
  if (approved) {
    const action: ChatToolCallApprovedAction = {
      type: "chat/toolCallConfirmed" as ChatToolCallApprovedAction["type"],
      turnId,
      toolCallId,
      approved: true,
      confirmed: "user-action" as ChatToolCallApprovedAction["confirmed"],
    };
    if (selectedOptionId) action.selectedOptionId = selectedOptionId;
    return action;
  }
  const action: ChatToolCallDeniedAction = {
    type: "chat/toolCallConfirmed" as ChatToolCallDeniedAction["type"],
    turnId,
    toolCallId,
    approved: false,
    reason: "denied" as ChatToolCallDeniedAction["reason"],
  };
  if (selectedOptionId) action.selectedOptionId = selectedOptionId;
  return action;
}

/**
 * Approve or deny a tool call awaiting *result* confirmation (after it ran).
 * Dispatched to the owning chat channel.
 */
export function chatToolCallResultConfirmed(params: {
  turnId: string;
  toolCallId: string;
  approved: boolean;
}): ChatToolCallResultConfirmedAction {
  return {
    type: "chat/toolCallResultConfirmed" as ChatToolCallResultConfirmedAction["type"],
    turnId: params.turnId,
    toolCallId: params.toolCallId,
    approved: params.approved,
  };
}