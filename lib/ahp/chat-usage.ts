import type { ChatState, UsageInfo } from "@microsoft/agent-host-protocol";
import type { ChatUsage } from "../types.ts";

const tokenFields = ["inputTokens", "outputTokens", "cacheReadTokens"] as const;

/** Sum receipts once per stable turn; cached input is a separate measurement, not extra input. */
export function projectChatUsage(
  chat: Pick<ChatState, "turns" | "activeTurn" | "turnsNextCursor"> | undefined,
  observedAt = new Date().toISOString(),
): ChatUsage | undefined {
  if (!chat) return undefined;
  const turns = new Map<string, { usage?: UsageInfo }>(chat.turns.map((turn) => [turn.id, turn]));
  if (chat.activeTurn) turns.set(chat.activeTurn.id, chat.activeTurn);
  const reports = [...turns.values()].map((turn) => turn.usage);
  const finite = (value: unknown): value is number =>
    typeof value === "number" && Number.isFinite(value) && value >= 0;
  const measured = reports.filter((usage): usage is UsageInfo =>
    !!usage && tokenFields.some((field) => finite(usage[field])));
  const models = [...new Set(reports.flatMap((usage) => usage?.model ? [usage.model] : []))];
  if (!measured.length && !models.length) return undefined;
  const total = (field: typeof tokenFields[number]) => {
    const values = measured.map((usage) => usage[field]).filter(finite);
    return values.length ? values.reduce((sum, value) => sum + value, 0) : undefined;
  };
  return {
    inputTokens: total("inputTokens"),
    outputTokens: total("outputTokens"),
    cacheReadTokens: total("cacheReadTokens"),
    models,
    scope: "loaded-turns",
    loadedTurns: turns.size,
    measuredTurns: measured.length,
    hasOlderTurns: chat.turnsNextCursor !== undefined,
    partial: measured.length !== turns.size
      || measured.some((usage) => !finite(usage.inputTokens) || !finite(usage.outputTokens)),
    observedAt,
  };
}
