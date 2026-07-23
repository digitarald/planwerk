/**
 * Minimal structural AHP response shapes used by text extraction. This stays
 * independent of the SDK so it can be regression-tested against newer parts.
 */
export interface ResponsePartLike {
  kind?: unknown;
  content?: unknown;
  toolCall?: unknown;
}

export interface TurnWithResponsePartsLike {
  responseParts?: readonly ResponsePartLike[] | null;
}

function isMarkdownPart(part: ResponsePartLike): part is ResponsePartLike & {
  kind: "markdown";
  content: string;
} {
  return part.kind === "markdown" && typeof part.content === "string";
}

/** Returns agent-authored markdown only; system notifications are not agent output. */
export function extractMarkdownResponseText(
  turns: readonly TurnWithResponsePartsLike[]
): string {
  let responseText = "";

  for (const turn of turns) {
    for (const part of turn.responseParts ?? []) {
      if (isMarkdownPart(part)) {
        responseText += part.content + "\n";
      }
    }
  }

  return responseText;
}

const MAX_AGENT_MESSAGE_LENGTH = 2000;

/**
 * Extract the last agent response from completed turns. Only trailing markdown
 * after the final tool call is agent output; system notifications are ignored.
 */
export function extractLastAgentMessage(
  turns: readonly TurnWithResponsePartsLike[],
  maxLength: number | null = MAX_AGENT_MESSAGE_LENGTH
): string | undefined {
  const limit = (message: string) =>
    maxLength === null ? message : message.slice(0, maxLength);

  for (let i = turns.length - 1; i >= 0; i--) {
    const parts = turns[i].responseParts;
    if (!parts?.length) continue;

    let lastToolIdx = -1;
    for (let j = parts.length - 1; j >= 0; j--) {
      if (parts[j].kind === "toolCall") {
        lastToolIdx = j;
        break;
      }
    }

    const trailingMarkdown = parts
      .slice(lastToolIdx + 1)
      .filter(isMarkdownPart)
      .map((part) => part.content)
      .join("")
      .trim();

    if (trailingMarkdown) {
      return limit(trailingMarkdown);
    }

    const allMarkdown = parts.filter(isMarkdownPart);
    const last = allMarkdown.at(-1)?.content.trim();
    if (last) return limit(last);
  }

  return undefined;
}
