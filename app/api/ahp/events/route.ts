import { NextResponse } from "next/server";

import { mockAHPSessions } from "@/lib/ahp/mock-sessions";
import { AHPEvent, AHPSessionSummary } from "@/lib/ahp/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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

export async function GET() {
  const encoder = new TextEncoder();
  let interval: ReturnType<typeof setInterval> | undefined;
  let autoClose: ReturnType<typeof setTimeout> | undefined;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const initEvent = `data: ${JSON.stringify({ type: "init", sessions: mockAHPSessions })}\n\n`;
      controller.enqueue(encoder.encode(initEvent));

      interval = setInterval(() => {
        try {
          const event = generateRandomUpdate(mockAHPSessions);
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

  return new NextResponse(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
