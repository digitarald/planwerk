import { NextRequest, NextResponse } from "next/server";

import { createAHPBridge, BridgeEvent } from "@/lib/ahp/client-bridge";
import { enrichSessionToCard } from "@/lib/ahp/enrich-card";
import { mapSessionToCard } from "@/lib/ahp/map-session";
import type { ChangesetEnrichment } from "@/lib/ahp/changeset-enricher";
import { ConnectionError } from "@/lib/ahp/connection-error";
import { AHPSessionSummary } from "@/lib/ahp/types";
import { getCachedSessions } from "@/lib/db/session-cache";
import { KanbanCard } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type CardStreamEvent =
  | { type: "init"; cards: KanbanCard[] }
  | { type: "cardChanged"; card: KanbanCard }
  | { type: "cardRemoved"; cardId: string }
  | ConnectionError;

function safeEnrich(session: AHPSessionSummary, changesetData?: ChangesetEnrichment | null): KanbanCard {
  try {
    return enrichSessionToCard(session, changesetData);
  } catch (err) {
    console.warn("[ahp:sse] enrichment failed, using base mapping:", err instanceof Error ? err.message : err);
    return mapSessionToCard(session);
  }
}

function projectRemoteEvent(event: BridgeEvent): CardStreamEvent {
  if (event.type === "error") {
    return event;
  }

  if (event.type === "init") {
    return {
      type: "init",
      cards: event.sessions.map((s) => safeEnrich(s, event.enrichments.get(s.resource))),
    };
  }

  if (event.type === "sessionRemoved") {
    return {
      type: "cardRemoved",
      cardId: event.resource,
    };
  }

  return {
    type: "cardChanged",
    card: safeEnrich(event.session, event.enrichment),
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
        // Serve cached data immediately for fast reload
        try {
          const cached = getCachedSessions(hostUrl);
          if (cached.length > 0) {
            const cards = cached.map((c) => safeEnrich(c.summary, c.enrichment));
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
            try {
              const projected = projectRemoteEvent(event);
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(projected)}\n\n`));
            } catch {
              // Stream closed by client
              abortController.abort();
            }
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
