import { NextRequest, NextResponse } from "next/server";

import {
  getInboxCounts,
  listInboxItems,
  purgeNonActionableInboxItems,
  refreshLegacyInboxPresentation,
} from "@/lib/db/inbox-store";
import { getDb } from "@/lib/db/schema";
import { validateLocalEventStreamRequest } from "@/lib/http/local-mutation";
import { parseInboxHostUrl, parseInboxListQuery } from "@/lib/inbox/api";
import { inboxEventMatchesHost, inboxEvents } from "@/lib/inbox/events";
import { serializeInboxListResponse } from "@/lib/inbox/contract";
import { refreshOpenInboxSynthesis } from "@/lib/inbox/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function createInboxStream(hostUrl: string | undefined): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | undefined;
  let keepAlive: ReturnType<typeof setInterval> | undefined;
  let closed = false;

  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(": connected\n\n"));
      unsubscribe = inboxEvents.subscribe((event) => {
        if (closed || !inboxEventMatchesHost(event, hostUrl)) return;
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
        );
      });
      keepAlive = setInterval(() => {
        if (!closed) controller.enqueue(encoder.encode(": keep-alive\n\n"));
      }, 25_000);
    },
    cancel() {
      closed = true;
      unsubscribe?.();
      if (keepAlive) clearInterval(keepAlive);
    },
  });
}

export function GET(request: NextRequest) {
  const wantsStream =
    request.nextUrl.searchParams.get("stream") === "1" ||
    request.headers.get("accept")?.includes("text/event-stream");
  if (wantsStream) {
    const requestError = validateLocalEventStreamRequest(request);
    if (requestError) {
      return NextResponse.json({ error: requestError }, { status: 403 });
    }
    const host = parseInboxHostUrl(request.nextUrl.searchParams.get("host"));
    if (!host.ok) {
      return NextResponse.json({ error: host.error }, { status: 400 });
    }
    return new NextResponse(createInboxStream(host.value), {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      },
    });
  }

  const parsed = parseInboxListQuery(request.nextUrl.searchParams);
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }
  const db = getDb();
  purgeNonActionableInboxItems(db, parsed.value.hostUrl);
  refreshLegacyInboxPresentation(db, {
    hostUrl: parsed.value.hostUrl,
  });
  refreshOpenInboxSynthesis(parsed.value.hostUrl, db);
  const result = listInboxItems(db, parsed.value);
  return NextResponse.json(serializeInboxListResponse(
    result.items,
    getInboxCounts(db, parsed.value.hostUrl),
  ));
}
