import { NextRequest, NextResponse } from "next/server";

import { createAHPBridge, BridgeEvent } from "@/lib/ahp/client-bridge";
import { enrichSessionToCard, type EnrichOptions } from "@/lib/ahp/enrich-card";
import { mapSessionToCard } from "@/lib/ahp/map-session";
import type { ChangesetEnrichment } from "@/lib/ahp/changeset-enricher";
import { ConnectionError } from "@/lib/ahp/connection-error";
import { AHPSessionSummary } from "@/lib/ahp/types";
import { getCachedSessions } from "@/lib/db/session-cache";
import { triageCard } from "@/lib/orchestrator/triage";
import { getPersistedCardPhase } from "@/lib/orchestrator/gate-engine";
import { getCardRisk } from "@/lib/orchestrator/risk-store";
import { startHeartbeat, stopHeartbeat, isHeartbeatRunning, type HeartbeatAction } from "@/lib/orchestrator/heartbeat";
import { isCardInAnyAutomationScope, parseWorkspaceScope } from "@/lib/automation-scope";
import { KanbanCard, type Phase, type RiskLevel } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type CardStreamEvent =
  | { type: "init"; cards: KanbanCard[] }
  | { type: "cardChanged"; card: KanbanCard; triage?: TriageEvent }
  | { type: "cardRemoved"; cardId: string }
  | { type: "heartbeat"; action: HeartbeatAction }
  | ConnectionError;

interface TriageEvent {
  riskLevel: RiskLevel;
  factors: string[];
  requiredGates: string[];
  requiresHumanApproval: boolean;
}

function safeEnrich(
  session: AHPSessionSummary,
  changesetData?: ChangesetEnrichment | null,
  options?: EnrichOptions,
  workers?: KanbanCard["workers"],
): KanbanCard {
  try {
    return enrichSessionToCard(session, changesetData, options, workers);
  } catch (err) {
    console.warn("[ahp:sse] enrichment failed, using base mapping:", err instanceof Error ? err.message : err);
    return mapSessionToCard(session, undefined, undefined, undefined, workers);
  }
}

const TRIAGE_PHASES: Phase[] = ["plan", "build"];

async function tryTriage(
  card: KanbanCard,
  session: AHPSessionSummary,
  enrichment?: ChangesetEnrichment | null
): Promise<TriageEvent | undefined> {
  if (!isCardInAnyAutomationScope(card, automationScopes.values())) return undefined;
  if (!TRIAGE_PHASES.includes(card.phase)) return undefined;

  // Only triage when the agent is done or waiting on input — not while running
  if (card.runtime === "running") return undefined;

  // Triage when the card's inferred phase differs from what's persisted in DB.
  const persistedPhase = getPersistedCardPhase(card.id);
  if (persistedPhase === card.phase) {
    if (getCardRisk(card.id)) return undefined;
  }

  try {
    const result = await triageCard(
      card.id,
      {
        title: session.title,
        activity: session.activity,
        filesChanged: session.changes?.files ?? 0,
        additions: session.changes?.additions ?? 0,
        deletions: session.changes?.deletions ?? 0,
        filePaths: enrichment?.fileChanges?.map(f => f.path),
        lastAgentMessage: enrichment?.lastAgentMessage,
        planContent: enrichment?.planContent,
      },
      card.phase
    );

    if (!result) return undefined;

    // Update the card's risk from the triage
    card.risk = result.risk.level;
    if (result.requiresHumanApproval) {
      card.attention = "needs-human";
    }

    return {
      riskLevel: result.risk.level,
      factors: result.risk.factors,
      requiredGates: result.requiredGates.map(
        (g) => g.gateName ?? g.gateType
      ),
      requiresHumanApproval: result.requiresHumanApproval,
    };
  } catch (err) {
    console.warn("[ahp:sse] triage failed:", err instanceof Error ? err.message : err);
    return undefined;
  }
}

async function projectRemoteEvent(event: BridgeEvent): Promise<CardStreamEvent> {
  if (event.type === "error") {
    return event;
  }

  if (event.type === "init") {
    const cards = event.sessions.map((s) => {
      const card = safeEnrich(s, event.enrichments.get(s.resource), undefined, event.workers.get(s.resource));
      const pi = event.pendingInputs.get(s.resource);
      if (pi) card.pendingInput = pi;
      return card;
    });
    return { type: "init", cards };
  }

  if (event.type === "sessionRemoved") {
    return {
      type: "cardRemoved",
      cardId: event.resource,
    };
  }

  const card = safeEnrich(event.session, event.enrichment, undefined, event.workers);
  // Attach pending input if available (null means explicitly cleared)
  if (event.pendingInput !== undefined) {
    card.pendingInput = event.pendingInput ?? undefined;
  }
  const triage = await tryTriage(card, event.session, event.enrichment);

  return {
    type: "cardChanged",
    card,
    triage,
  };
}

/**
 * Safety net: when the SSE endpoint is hit without a host param (e.g., during
 * rehydration edge cases), emit an empty board so the client has a valid init.
 */
function createEmptyStream(): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const initEvent = `data: ${JSON.stringify({ type: "init", cards: [] } satisfies CardStreamEvent)}\n\n`;
      controller.enqueue(encoder.encode(initEvent));
    },
  });
}

// Module-level card state for heartbeat access
let currentCards: KanbanCard[] = [];
let activeStreamCount = 0;
let nextStreamId = 0;
const automationScopes = new Map<number, Set<string> | null>();

function getAutomationCards(): KanbanCard[] {
  return currentCards.filter((card) =>
    isCardInAnyAutomationScope(card, automationScopes.values())
  );
}

function createRemoteStream(
  hostUrl: string,
  workspaceScope: Set<string> | null
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const abortController = new AbortController();
  const streamId = nextStreamId++;
  let closed = false;

  function closeStream(): void {
    if (closed) return;
    closed = true;
    abortController.abort();
    automationScopes.delete(streamId);
    activeStreamCount--;
    if (activeStreamCount <= 0) {
      activeStreamCount = 0;
      stopHeartbeat();
    }
  }

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      activeStreamCount++;
      automationScopes.set(streamId, workspaceScope);

      // Start heartbeat if this is the first active stream
      if (!isHeartbeatRunning()) {
        startHeartbeat(
          hostUrl,
          getAutomationCards,
          (action) => {
            try {
              const event: CardStreamEvent = { type: "heartbeat", action };
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));

              // Phase-advance actions should also update the board immediately
              if (action.type === "phase-advanced" && "cardId" in action) {
                const card = currentCards.find((c) => c.id === action.cardId);
                if (card) {
                  const updated = { ...card, phase: action.to };
                  currentCards = [...currentCards.filter((c) => c.id !== card.id), updated];
                  const cardEvent: CardStreamEvent = { type: "cardChanged", card: updated };
                  controller.enqueue(encoder.encode(`data: ${JSON.stringify(cardEvent)}\n\n`));
                }
              }
            } catch {
              // Stream may already be closed
            }
          }
        );
      }

      try {
        let streamWrites = Promise.resolve();

        // Serve cached data immediately for fast reload
        try {
          const cached = getCachedSessions(hostUrl);
          if (cached.length > 0) {
            const cards = cached.map((c) => safeEnrich(c.summary, c.enrichment, { recordStatus: false }));
            currentCards = cards;
            const cacheEvent: CardStreamEvent = { type: "init", cards };
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(cacheEvent)}\n\n`));
          }
        } catch {
          // Cache read failure is non-fatal
        }

        await createAHPBridge({
          hostUrl,
          signal: abortController.signal,
          onEvent(event: BridgeEvent) {
            streamWrites = streamWrites
              .then(async () => {
                const projected = await projectRemoteEvent(event);
                // Track card state for heartbeat (immutable updates)
                if (projected.type === "init") {
                  currentCards = projected.cards;
                } else if (projected.type === "cardChanged") {
                  // pendingInput is fetched asynchronously and arrives on its
                  // own event; enrichment events (changeset/plan) re-emit the
                  // card without it. Preserve the existing pendingInput while
                  // the card is still input-needed so those events don't clobber
                  // it (mirrors the client store's mergeCard semantics). Once the
                  // input resolves, runtime leaves input-needed and it clears.
                  const incoming = projected.card;
                  const existing = currentCards.find((c) => c.id === incoming.id);
                  if (
                    existing?.pendingInput &&
                    !incoming.pendingInput &&
                    incoming.runtime === "input-needed"
                  ) {
                    incoming.pendingInput = existing.pendingInput;
                  }
                  currentCards = [
                    ...currentCards.filter((c) => c.id !== incoming.id),
                    incoming,
                  ];
                } else if (projected.type === "cardRemoved") {
                  currentCards = currentCards.filter((c) => c.id !== projected.cardId);
                }
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(projected)}\n\n`));
              })
              .catch(() => {
                // Stream closed by client
                closeStream();
              });
          },
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : "Connection failed";
        try {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ type: "error", message })}\n\n`)
          );
          controller.close();
        } catch {}
        closeStream();
      }
    },
    cancel() {
      closeStream();
    },
  });
}

export async function GET(request: NextRequest) {
  const hostUrl = request.nextUrl.searchParams.get("host");
  console.info("[ahp:sse]", hostUrl ? `remote stream → ${hostUrl}` : "no host (empty board)");
  const workspaceScope = parseWorkspaceScope(request.nextUrl.searchParams.get("workspaceScope"));
  const stream = hostUrl ? createRemoteStream(hostUrl, workspaceScope) : createEmptyStream();

  return new NextResponse(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
