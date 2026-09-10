import { NextRequest, NextResponse } from "next/server";

import { CopilotClient } from "@github/copilot-sdk";
import type { CopilotSession } from "@github/copilot-sdk";

import { getDb } from "@/lib/db/schema";
import { disposeOneShotSession } from "@/lib/orchestrator/copilot-session";
import { buildSystemPrompt } from "@/lib/orchestrator/orchestrator-agent";
import { executeToolCall } from "@/lib/orchestrator/tool-executor";
import type { OrchestratorToolName } from "@/lib/orchestrator/orchestrator-agent";
import { ORCHESTRATOR_MODEL } from "@/lib/orchestrator/model";
import type { KanbanCard } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_TOOL_NAMES: Set<string> = new Set([
  "create_session", "send_message", "answer_input",
  "trigger_review", "trigger_gate", "override_phase", "assess_risk",
]);

function isLocalHost(url: string): boolean {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
  } catch {
    return false;
  }
}

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
        model: ORCHESTRATOR_MODEL,
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
  const session = copilotSession;
  const client = copilotClient;
  copilotSession = null;
  copilotClient = null;

  if (session && client) {
    await disposeOneShotSession(
      client,
      session,
      true,
      "[orchestrator-chat]"
    );
  } else if (session) {
    try {
      await session.abort();
      await session.disconnect();
    } catch (error) {
      console.warn(
        "[orchestrator-chat] Failed to release Copilot SDK session:",
        error instanceof Error ? error.message : error
      );
    }
  }

  if (client) {
    const errors = await client.stop().catch((error) => [error]);
    if (errors.length > 0) {
      console.warn("[orchestrator-chat] Failed to stop Copilot SDK client:", errors);
    }
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

/**
 * Chat endpoint — streams response via SSE for progressive rendering.
 * Each SSE event is a JSON object with type: "text" | "tool" | "done" | "error"
 */
export async function POST(request: NextRequest) {
  const { message, selectedCardId, cards: clientCards, hostUrl } = (await request.json()) as {
    message?: string;
    selectedCardId?: string;
    cards?: KanbanCard[];
    hostUrl?: string;
  };

  if (!message) {
    return NextResponse.json({ error: "message required" }, { status: 400 });
  }

  // Validate hostUrl is localhost-only to prevent SSRF
  if (hostUrl && !isLocalHost(hostUrl)) {
    return NextResponse.json({ error: "hostUrl must be localhost" }, { status: 400 });
  }

  const cards = clientCards ?? getCardsFromDb();
  const selectedCard = selectedCardId
    ? cards.find((c) => c.id === selectedCardId)
    : undefined;

  const systemContext = buildSystemPrompt(cards, selectedCard);
  const fullPrompt = `<board_context>\n${systemContext}\n</board_context>\n\n<user_message>\n${message}\n</user_message>`;

  // Try LLM-powered streaming response via Copilot SDK
  const session = await ensureSession();
  if (session) {
    try {
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        async start(controller) {
          function send(data: Record<string, unknown>) {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
          }

          let fullResponse = "";

          const unsubscribe = session!.on((event) => {
            if (event.type === "assistant.message") {
              const content = event.data?.content;
              if (content) {
                fullResponse = content;
              }
            }
          });

          try {
            const response = await session!.sendAndWait(
              { prompt: fullPrompt },
              60_000
            );

            const content = response?.data?.content ?? fullResponse;

            if (content) {
              // Check if response contains tool-call patterns (action suggestions)
              const toolActions = parseToolActions(content);
              if (toolActions.length > 0 && hostUrl) {
                // Execute tool calls server-side
                for (const action of toolActions) {
                  const result = await executeToolCall(
                    action.name as OrchestratorToolName,
                    action.args,
                    { hostUrl, cards }
                  );
                  send({ type: "tool", name: action.name, result });
                }
              }

              send({ type: "text", content });
              send({ type: "done" });
            } else {
              send({ type: "text", content: generateFallback(message, cards, selectedCard) });
              send({ type: "done", source: "fallback" });
            }
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            console.warn("[orchestrator-chat] Copilot SDK error:", errMsg);
            send({ type: "text", content: generateFallback(message, cards, selectedCard) });
            send({ type: "done", source: "fallback" });
            resetSession().catch(() => {});
          } finally {
            unsubscribe();
            controller.close();
          }
        },
      });

      return new NextResponse(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
        },
      });
    } catch (err) {
      console.warn("[orchestrator-chat] Stream setup error:", err instanceof Error ? err.message : err);
      await resetSession();
    }
  }

  // Non-streaming fallback
  const fallbackResponse = generateFallback(message, cards, selectedCard);
  return NextResponse.json({ response: fallbackResponse, source: "fallback" });
}

/**
 * Parse tool call patterns from the LLM response text.
 * The LLM may embed action markers like [ACTION: tool_name(args)]
 */
function parseToolActions(content: string): Array<{ name: string; args: Record<string, unknown> }> {
  const actions: Array<{ name: string; args: Record<string, unknown> }> = [];
  const pattern = /\[ACTION:\s*(\w+)\(([^)]*)\)\]/g;
  let match;

  while ((match = pattern.exec(content)) !== null) {
    const name = match[1];
    if (!ALLOWED_TOOL_NAMES.has(name)) continue;
    const argsStr = match[2];
    try {
      const args = argsStr ? JSON.parse(`{${argsStr}}`) : {};
      actions.push({ name, args });
    } catch {
      // Skip malformed action
    }
  }

  return actions;
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
