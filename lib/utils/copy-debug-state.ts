import type { KanbanCard } from "@/lib/types";
import type { FeedItem } from "@/lib/store/orchestrator-store";

export interface DebugState {
  card: KanbanCard;
  feedItems: FeedItem[];
  copiedAt: string;
}

function buildDebugMarkdown(state: DebugState): string {
  const { card, feedItems, copiedAt } = state;

  const lines: string[] = [
    `# Debug State: ${card.title}`,
    "",
    `Copied at: ${copiedAt}`,
    "",
    "## Session Card",
    "",
    "```json",
    JSON.stringify(card, null, 2),
    "```",
  ];

  if (feedItems.length > 0) {
    lines.push(
      "",
      "## Orchestrator Feed (related)",
      "",
      "```json",
      JSON.stringify(feedItems, null, 2),
      "```"
    );
  }

  return lines.join("\n");
}

export async function copyDebugState(
  card: KanbanCard,
  feedItems: FeedItem[]
): Promise<void> {
  const state: DebugState = {
    card,
    feedItems: feedItems.filter((item) => item.cardId === card.id),
    copiedAt: new Date().toISOString(),
  };

  const markdown = buildDebugMarkdown(state);
  await navigator.clipboard.writeText(markdown);
}
