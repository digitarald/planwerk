import type { SessionDetails, SessionRuntimeError } from "../types.ts";
import { extractLastAgentMessage } from "./response-parts.ts";

interface ErrorInfoLike {
  errorType?: unknown;
  message?: unknown;
  stack?: unknown;
}

interface SessionStateLike {
  defaultChat?: unknown;
  creationError?: ErrorInfoLike;
  chats?: readonly { resource?: string; interactivity?: string }[];
}

interface ResponsePartLike {
  kind?: unknown;
  content?: unknown;
  error?: ErrorInfoLike;
  resumable?: unknown;
}

interface TurnLike {
  id?: unknown;
  startedAt?: unknown;
  state?: unknown;
  responseParts?: readonly ResponsePartLike[] | null;
}

interface ChatStateLike {
  resource?: unknown;
  turns?: readonly TurnLike[] | null;
  interactivity?: string;
}

const MAX_ERROR_MESSAGE_LENGTH = 4_000;
const MAX_ERROR_STACK_LENGTH = 8_000;

function boundedString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, maxLength) : undefined;
}

function errorDetail(
  error: ErrorInfoLike | undefined,
): Pick<SessionRuntimeError, "errorType" | "message" | "stack"> | undefined {
  const message = boundedString(error?.message, MAX_ERROR_MESSAGE_LENGTH);
  if (!message) return undefined;
  return {
    errorType: boundedString(error?.errorType, 200) ?? "runtime-error",
    message,
    stack: boundedString(error?.stack, MAX_ERROR_STACK_LENGTH),
  };
}

export function projectSessionDetails(
  sessionState: SessionStateLike,
  chatState?: ChatStateLike,
): SessionDetails {
  if (chatState?.interactivity === "hidden"
    || sessionState.chats?.some((chat) => chat.resource === sessionState.defaultChat && chat.interactivity === "hidden")) return {};
  const turns = chatState?.turns ?? [];
  const latestTurn = turns.at(-1);
  const finalPart = latestTurn?.responseParts?.at(-1);
  const turnError =
    latestTurn?.state === "error" && finalPart?.kind === "error"
      ? errorDetail(finalPart.error)
      : undefined;

  if (turnError) {
    return {
      lastAgentMessage: extractLastAgentMessage(turns),
      runtimeError: {
        source: "turn",
        ...turnError,
        chatUri:
          typeof chatState?.resource === "string"
            ? chatState.resource
            : typeof sessionState.defaultChat === "string"
              ? sessionState.defaultChat
              : undefined,
        turnId: typeof latestTurn?.id === "string" ? latestTurn.id : undefined,
        startedAt:
          typeof latestTurn?.startedAt === "string"
            ? latestTurn.startedAt
            : undefined,
        resumable: finalPart?.resumable === true,
      },
    };
  }

  const creationError = errorDetail(sessionState.creationError);
  const outcome = latestTurn?.state === "complete" ? extractLastAgentMessage([latestTurn], 8_001) : undefined;
  const chatUri = chatState?.resource ?? sessionState.defaultChat;
  return {
    lastAgentMessage: extractLastAgentMessage(turns),
    outcomeEvidence: outcome && typeof latestTurn?.id === "string" && typeof chatUri === "string"
      ? { chatUri, turnId: latestTurn.id, state: "complete", text: outcome.slice(0, 8_000), truncated: outcome.length > 8_000 }
      : undefined,
    runtimeError: creationError
      ? {
          source: "creation",
          ...creationError,
          resumable: false,
        }
      : undefined,
  };
}

export function matchesResumableTurn(
  details: SessionDetails,
  chatUri: string,
  turnId: string,
): boolean {
  const error = details.runtimeError;
  return Boolean(
    error?.source === "turn" &&
    error.resumable &&
    error.chatUri === chatUri &&
    error.turnId === turnId,
  );
}
