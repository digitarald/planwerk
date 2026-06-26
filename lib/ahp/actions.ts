import type {
  ChatTurnStartedAction,
  ChatPendingMessageSetAction,
  ChatInputAnswerChangedAction,
  ChatInputCompletedAction,
  ChatInputAnswer,
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
export function chatTurnStarted(turnId: string, text: string): ChatTurnStartedAction {
  return {
    type: "chat/turnStarted" as ChatTurnStartedAction["type"],
    turnId,
    message: userMessage(text),
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
