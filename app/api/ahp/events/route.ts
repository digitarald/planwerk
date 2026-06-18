import { NextRequest, NextResponse } from "next/server";

import { createAHPBridge, BridgeEvent } from "@/lib/ahp/client-bridge";
import { enrichSessionToCard } from "@/lib/ahp/enrich-card";
import { mapSessionToCard } from "@/lib/ahp/map-session";
import type { ChangesetEnrichment } from "@/lib/ahp/changeset-enricher";
import { ConnectionError } from "@/lib/ahp/connection-error";
import { AHPSessionSummary } from "@/lib/ahp/types";
import { getCachedSessions } from "@/lib/db/session-cache";
import { triageCard, type TriageResult } from "@/lib/orchestrator/triage";
import { getPersistedCardPhase } from "@/lib/orchestrator/gate-engine";
import { KanbanCard, type Phase, type RiskLevel } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type CardStreamEvent =
  | { type: "init"; cards: KanbanCard[] }
  | { type: "cardChanged"; card: KanbanCard; triage?: TriageEvent }
  | { type: "cardRemoved"; cardId: string }
  | ConnectionError;

interface TriageEvent {
  riskLevel: RiskLevel;
  factors: string[];
  requiredGates: string[];
  requiresHumanApproval: boolean;
}

async function safeEnrich(
  session: AHPSessionSummary,
  changesetData?: ChangesetEnrichment | null
): Promise<KanbanCard> {
  try {
    return await enrichSessionToCard(session, changesetData);
  } catch (err) {
    console.warn("[ahp:sse] enrichment failed, using base mapping:", err instanceof Error ? err.message : err);
    return await mapSessionToCard(session);
  }
}

const TRIAGE_PHASES: Phase[] = ["plan", "build"];

async function tryTriage(
  card: KanbanCard,
  session: AHPSessionSummary,
  enrichment?: ChangesetEnrichment | null
): Promise<TriageEvent | undefined> {
  if (!TRIAGE_PHASES.includes(card.phase)) return undefined;

  // Only triage if the card just entered this phase (previous persisted phase differs)
  const previousPhase = getPersistedCardPhase(card.id);
  if (previousPhase === card.phase) return undefined;

  try {
    const result = await triageCard(
      card.id,
      {
        title: session.title,
        activity: session.activity,
        filesChanged: session.changes?.files ?? 0,
        additions: session.changes?.additions ?? 0,
        deletions: session.changes?.deletions ?? 0,
        filePaths: enrichment?.filePaths,
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
    return {
      type: "init",
      cards: await Promise.all(
        event.sessions.map((s) => safeEnrich(s, event.enrichments.get(s.resource)))
      ),
    };
  }

  if (event.type === "sessionRemoved") {
    return {
      type: "cardRemoved",
      cardId: event.resource,
    };
  }

  const card = await safeEnrich(event.session, event.enrichment);
  const triage = await tryTriage(card, event.session, event.enrichment);

  return {
    type: "cardChanged",
    card,
    triage,
  };
}

/** When no host is connected, emit an empty board */
function createEmptyStream(): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const initEvent = `data: ${JSON.stringify({ type: "init", cards: [] } satisfies CardStreamEvent)}\n\n`;
      controller.enqueue(encoder.encode(initEvent));
    },
  });
}

function createRemoteStream(hostUrl: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const abortController = new AbortController();

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        let streamWrites = Promise.resolve();

        // Serve cached data immediately for fast reload
        try {
          const cached = getCachedSessions(hostUrl);
          if (cached.length > 0) {
            const cards = await Promise.all(cached.map((c) => safeEnrich(c.summary, c.enrichment)));
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
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(projected)}\n\n`));
              })
              .catch(() => {
                // Stream closed by client
                abortController.abort();
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
      }
    },
    cancel() {
      abortController.abort();
    },
  });
}

export async function GET(request: NextRequest) {
  const hostUrl = request.nextUrl.searchParams.get("host");
  console.info("[ahp:sse]", hostUrl ? `remote stream → ${hostUrl}` : "no host (empty board)");
  const stream = hostUrl ? createRemoteStream(hostUrl) : createEmptyStream();

  return new NextResponse(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
