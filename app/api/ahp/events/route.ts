import { NextRequest, NextResponse } from "next/server";

import { createAHPBridge, BridgeEvent } from "@/lib/ahp/client-bridge";
import { enrichSessionToCard } from "@/lib/ahp/enrich-card";
import { mapSessionToCard } from "@/lib/ahp/map-session";
import { ConnectionError } from "@/lib/ahp/connection-error";
import { mockAHPSessions } from "@/lib/ahp/mock-sessions";
import { AHPEvent, AHPSessionSummary } from "@/lib/ahp/types";
import { KanbanCard } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type CardStreamEvent =
  | { type: "init"; cards: KanbanCard[] }
  | { type: "cardChanged"; card: KanbanCard }
  | { type: "cardRemoved"; cardId: string }
  | ConnectionError;

function safeEnrich(session: AHPSessionSummary): KanbanCard {
  try {
    return enrichSessionToCard(session);
  } catch (err) {
    console.warn("[ahp:sse] enrichment failed, using base mapping:", err instanceof Error ? err.message : err);
    return mapSessionToCard(session);
  }
}

function generateRandomUpdate(sessions: AHPSessionSummary[]): AHPEvent {
  const session = sessions[Math.floor(Math.random() * sessions.length)];
  const activities = [
    "Implementing feature...",
    "Running tests...",
    "Fixing lint errors...",
    "Writing documentation...",
    "Refactoring code...",
    "Waiting for review...",
  ];

  return {
    type: "sessionSummaryChanged",
    session: {
      ...session,
      modifiedAt: new Date().toISOString(),
      activity: activities[Math.floor(Math.random() * activities.length)],
      changes: session.changes
        ? {
            ...session.changes,
            additions: session.changes.additions + Math.floor(Math.random() * 5),
          }
        : undefined,
    },
  };
}

function projectRemoteEvent(event: BridgeEvent): CardStreamEvent {
  if (event.type === "error") {
    return event;
  }

  if (event.type === "init") {
    return {
      type: "init",
      cards: event.sessions.map(safeEnrich),
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
    card: safeEnrich(event.session),
  };
}

function projectMockEvent(
  event: { type: "init"; sessions: AHPSessionSummary[] } | AHPEvent
): CardStreamEvent {
  if (event.type === "init") {
    return {
      type: "init",
      cards: event.sessions.map(safeEnrich),
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
    card: safeEnrich(event.session),
  };
}

function createMockStream(): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let interval: ReturnType<typeof setInterval> | undefined;
  let autoClose: ReturnType<typeof setTimeout> | undefined;

  return new ReadableStream<Uint8Array>({
    start(controller) {
      const initEvent = `data: ${JSON.stringify(
        projectMockEvent({ type: "init", sessions: mockAHPSessions })
      )}\n\n`;
      controller.enqueue(encoder.encode(initEvent));

      interval = setInterval(() => {
        try {
          const event = projectMockEvent(generateRandomUpdate(mockAHPSessions));
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch {
          if (interval) {
            clearInterval(interval);
          }
        }
      }, 5000 + Math.random() * 5000);

      autoClose = setTimeout(() => {
        if (interval) {
          clearInterval(interval);
        }
        try {
          controller.close();
        } catch {}
      }, 5 * 60 * 1000);
    },
    cancel() {
      if (interval) {
        clearInterval(interval);
      }
      if (autoClose) {
        clearTimeout(autoClose);
      }
    },
  });
}

function createRemoteStream(hostUrl: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const abortController = new AbortController();

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
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
  console.info("[ahp:sse]", hostUrl ? `remote stream → ${hostUrl}` : "mock stream");
  const stream = hostUrl ? createRemoteStream(hostUrl) : createMockStream();

  return new NextResponse(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
