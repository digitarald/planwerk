import type { ConversationDetails } from "../types.ts";

/** Older host pages prepend; repeated stable identities update rather than duplicate. */
export function mergeConversationEvidence(previous: ConversationDetails | undefined, page: ConversationDetails): ConversationDetails {
  if (!previous || previous.chatUri !== page.chatUri) return page;
  const turns = new Map(page.turns.map((turn) => [turn.turnId, turn]));
  for (const turn of previous.turns) {
    if (!turns.has(turn.turnId)) turns.set(turn.turnId, turn);
  }
  return {
    ...page, turns: [...turns.values()].slice(-200),
    historyTruncated: page.historyTruncated || previous.historyTruncated || turns.size > 200,
  };
}
