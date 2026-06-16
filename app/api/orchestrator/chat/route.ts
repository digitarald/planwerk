import { NextRequest, NextResponse } from "next/server";

import { getDb } from "@/lib/db/schema";

type PhaseCountRow = {
  phase: string;
  count: number;
};

type StatusCountRow = {
  status: string;
  count: number;
};

type CardPhaseRow = {
  card_id: string;
  phase: string;
  updated_at: string;
};

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function parseTimestamp(value: string): number {
  return new Date(value.replace(" ", "T") + "Z").getTime();
}

function formatAge(updatedAt: string): string {
  const ageMs = Math.max(0, Date.now() - parseTimestamp(updatedAt));
  const ageMinutes = Math.floor(ageMs / 60000);

  if (ageMinutes < 1) return "just now";
  if (ageMinutes === 1) return "1 minute ago";
  if (ageMinutes < 60) return `${ageMinutes} minutes ago`;

  const ageHours = Math.floor(ageMinutes / 60);
  if (ageHours === 1) return "1 hour ago";
  if (ageHours < 24) return `${ageHours} hours ago`;

  const ageDays = Math.floor(ageHours / 24);
  return ageDays === 1 ? "1 day ago" : `${ageDays} days ago`;
}

function buildSelectedCardSummary(card?: CardPhaseRow): string {
  if (!card) return "";
  return ` Selected card ${card.card_id} is in ${card.phase} and last changed ${formatAge(card.updated_at)}.`;
}

function generateResponse(
  message: string,
  selectedCard?: CardPhaseRow,
): { response: string; action?: string } {
  const db = getDb();
  const lower = message.toLowerCase();
  const phaseRows = db
    .prepare("SELECT phase, COUNT(*) as count FROM card_phases GROUP BY phase")
    .all() as PhaseCountRow[];
  const runningRows = db
    .prepare(
      "SELECT status, COUNT(*) as count FROM gate_runs WHERE status = 'running' GROUP BY status",
    )
    .all() as StatusCountRow[];
  const phaseMap = Object.fromEntries(
    phaseRows.map((row) => [row.phase, Number(row.count)]),
  ) as Record<string, number>;
  const runningCount = runningRows[0]?.count ?? 0;
  const selectedCardSummary = buildSelectedCardSummary(selectedCard);

  if (
    lower.includes("create") ||
    lower.includes("new") ||
    lower.includes("start")
  ) {
    return {
      response:
        "I'll create a new task. What should it be called? Or paste a GitHub issue URL and I'll extract the details.",
      action: "prompt_create",
    };
  }

  if (lower.includes("override") || lower.includes("skip")) {
    return {
      response:
        "Got it. I'll mark the review gate as manually approved. Note: this bypasses the adversarial review — the card will move to the next phase without AI validation.",
      action: "override",
    };
  }

  if (lower.includes("pause") || lower.includes("stop")) {
    const activeCards = db
      .prepare("SELECT COUNT(*) as count FROM card_phases WHERE phase != 'ship'")
      .get() as { count: number };

    return {
      response: `Pausing active sessions. ${activeCards.count} cards are currently in progress outside ship, and ${runningCount} gate runs are active.${selectedCardSummary}`,
      action: "pause",
    };
  }

  if (
    lower.includes("status") ||
    lower.includes("board") ||
    lower.includes("how")
  ) {
    return {
      response: `Board: ${phaseMap.define || 0} defining, ${phaseMap.plan || 0} planning, ${phaseMap.build || 0} building, ${phaseMap.review || 0} in review, ${phaseMap.ship || 0} shipped. ${runningCount} gate runs active.${selectedCardSummary}`,
      action: "status",
    };
  }

  if (lower.includes("stuck") || lower.includes("why")) {
    if (selectedCard) {
      return {
        response: `${selectedCard.card_id} is in ${selectedCard.phase} and has been idle since ${selectedCard.updated_at} (${formatAge(selectedCard.updated_at)}). There are ${runningCount} running gate checks right now.`,
        action: "diagnose",
      };
    }

    const oldestIdle = db
      .prepare(
        "SELECT * FROM card_phases ORDER BY updated_at ASC LIMIT 3",
      )
      .all() as CardPhaseRow[];

    if (oldestIdle.length === 0) {
      return {
        response: "Nothing looks stuck yet — there are no tracked cards on the board.",
        action: "diagnose",
      };
    }

    const summary = oldestIdle
      .map(
        (card) =>
          `${card.card_id} in ${card.phase} (last update ${formatAge(card.updated_at)})`,
      )
      .join("; ");

    return {
      response: `Oldest idle cards: ${summary}. ${runningCount} gate runs are currently active.`,
      action: "diagnose",
    };
  }

  if (lower.includes("next") || lower.includes("what should")) {
    const nextCards = db
      .prepare(
        "SELECT * FROM card_phases WHERE phase = 'define' ORDER BY updated_at ASC LIMIT 3",
      )
      .all() as CardPhaseRow[];

    if (nextCards.length === 0) {
      return {
        response: `There are no cards waiting in define right now. ${phaseMap.plan || 0} cards are already in planning and ${phaseMap.build || 0} are in build.${selectedCardSummary}`,
        action: "suggest",
      };
    }

    const [firstCard] = nextCards;
    const backlog = nextCards
      .map((card) => `${card.card_id} (${formatAge(card.updated_at)})`)
      .join(", ");

    return {
      response: `Next up, I would move ${firstCard.card_id} out of define. Define candidates waiting longest: ${backlog}. ${runningCount} gate runs are active.${selectedCardSummary}`,
      action: "suggest",
    };
  }

  return {
    response: `Board summary: ${phaseMap.define || 0} defining, ${phaseMap.plan || 0} planning, ${phaseMap.build || 0} building, ${phaseMap.review || 0} in review, ${phaseMap.ship || 0} shipped. ${runningCount} gate runs active.${selectedCardSummary}`,
  };
}

export async function POST(request: NextRequest) {
  const { message, selectedCardId } = (await request.json()) as {
    message?: string;
    selectedCardId?: string;
  };

  if (!message) {
    return NextResponse.json({ error: "message required" }, { status: 400 });
  }

  const db = getDb();
  const selectedCard = selectedCardId
    ? ((db
        .prepare("SELECT * FROM card_phases WHERE card_id = ?")
        .get(selectedCardId) as CardPhaseRow | undefined) ?? undefined)
    : undefined;

  const { response, action } = generateResponse(message, selectedCard);

  return NextResponse.json({ response, action });
}
