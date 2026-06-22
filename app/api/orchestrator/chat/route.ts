import { NextRequest, NextResponse } from "next/server";

import { CopilotClient } from "@github/copilot-sdk";
import type { CopilotSession } from "@github/copilot-sdk";

import { getDb } from "@/lib/db/schema";
import { buildSystemPrompt } from "@/lib/orchestrator/orchestrator-agent";
import type { KanbanCard } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Module-level singleton for the orchestrator Copilot session
let copilotClient: CopilotClient | null = null;
let copilotSession: CopilotSession | null = null;
let clientStarting: Promise<void> | null = null;

async function ensureSession(): Promise<CopilotSession | null> {
  if (copilotSession) return copilotSession;
  if (clientStarting) {
    await clientStarting;
    return copilotSession;
  }

  clientStarting = (async () => {
    try {
      copilotClient = new CopilotClient();
      await copilotClient.start();
      copilotSession = await copilotClient.createSession({
        model: "gpt-4.1",
        systemMessage: {
          content:
            "You are the CTO agent for Planwerk — an autonomous SDLC orchestrator. You help manage AI agent sessions flowing through a kanban pipeline. Be concise and actionable.",
        },
      });
    } catch (err) {
      console.warn("[orchestrator-chat] Failed to start Copilot SDK:", err instanceof Error ? err.message : err);
      copilotClient = null;
      copilotSession = null;
    } finally {
      clientStarting = null;
    }
  })();

  await clientStarting;
  return copilotSession;
}

async function resetSession() {
  if (copilotSession) {
    await copilotSession.disconnect().catch(() => {});
    copilotSession = null;
  }
  if (copilotClient) {
    await copilotClient.stop().catch(() => {});
    copilotClient = null;
  }
}

type CardPhaseRow = {
  card_id: string;
  phase: string;
  updated_at: string;
};

function getCardsFromDb(): KanbanCard[] {
  const db = getDb();
  const rows = db
    .prepare("SELECT card_id, phase, updated_at FROM card_phases")
    .all() as CardPhaseRow[];

  return rows.map((row) => ({
    id: row.card_id,
    title: row.card_id,
    phase: row.phase as KanbanCard["phase"],
    runtime: "idle" as const,
    gateStatus: "pending" as const,
    attention: "none" as const,
    risk: "low" as const,
    activity: "",
    additions: 0,
    deletions: 0,
    filesChanged: 0,
    planSteps: { total: 0, done: 0 },
    modifiedAt: new Date(row.updated_at).getTime(),
  }));
}

export async function POST(request: NextRequest) {
  const { message, selectedCardId, cards: clientCards } = (await request.json()) as {
    message?: string;
    selectedCardId?: string;
    cards?: KanbanCard[];
  };

  if (!message) {
    return NextResponse.json({ error: "message required" }, { status: 400 });
  }

  // Use client-provided cards (full state) or fall back to DB-only cards
  const cards = clientCards ?? getCardsFromDb();
  const selectedCard = selectedCardId
    ? cards.find((c) => c.id === selectedCardId)
    : undefined;

  // Build contextual prompt — separate system context from user input
  const systemContext = buildSystemPrompt(cards, selectedCard);
  // Board context goes as structured data; user message is clearly delimited
  const fullPrompt = `<board_context>\n${systemContext}\n</board_context>\n\n<user_message>\n${message}\n</user_message>`;

  // Try LLM-powered response via Copilot SDK
  const session = await ensureSession();
  if (session) {
    try {
      const response = await session.sendAndWait(
        { prompt: fullPrompt },
        30_000
      );

      const content = response?.data?.content;
      if (content) {
        return NextResponse.json({ response: content, source: "copilot" });
      }
    } catch (err) {
      console.warn("[orchestrator-chat] Copilot SDK error:", err instanceof Error ? err.message : err);
      await resetSession();
    }
  }

  // Fallback: use the existing keyword-based response
  const fallbackResponse = generateFallback(message, cards, selectedCard);
  return NextResponse.json({ response: fallbackResponse, source: "fallback" });
}

function generateFallback(
  message: string,
  cards: KanbanCard[],
  selectedCard?: KanbanCard
): string {
  const lower = message.toLowerCase();
  const phases = { define: 0, plan: 0, build: 0, review: 0, ship: 0 };
  for (const card of cards) {
    if (card.phase in phases) {
      phases[card.phase as keyof typeof phases]++;
    }
  }

  const summary = `Board: ${phases.define} defining, ${phases.plan} planning, ${phases.build} building, ${phases.review} in review, ${phases.ship} shipped.`;

  if (lower.includes("status") || lower.includes("board") || lower.includes("how")) {
    return summary + (selectedCard ? ` Selected: ${selectedCard.title} in ${selectedCard.phase}.` : "");
  }

  if (lower.includes("stuck") || lower.includes("why")) {
    return selectedCard
      ? `${selectedCard.title} is in ${selectedCard.phase} (${selectedCard.runtime}). Check if it needs input or has a gate failure.`
      : `${summary} Use "stuck" with a selected card for details.`;
  }

  if (lower.includes("next") || lower.includes("what should")) {
    const attentionCards = cards.filter((c) => c.attention !== "none" || c.runtime === "input-needed");
    if (attentionCards.length > 0) {
      return `Priority: ${attentionCards[0].title} needs attention (${attentionCards[0].attention || attentionCards[0].runtime}).`;
    }
    return `${summary} No cards need immediate attention.`;
  }

  return summary;
}
