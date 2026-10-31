import { NextRequest, NextResponse } from "next/server";
import { type AHPSessionSummary, shouldShowSession } from "@/lib/ahp/types";
import { listAllSessions } from "@/lib/ahp/catalog";
import { connectInitializedAhpClient } from "@/lib/ahp/endpoint";
import { mapSdkSessionSummary } from "@/lib/ahp/session-summary";
import { runTaskCreation, type TaskCreationEvent } from "@/lib/ahp/task-creation";
import { parseCreationRequest } from "@/lib/ahp/creation-request";
import { CreationConfigError } from "@/lib/ahp/session-config";
import { ahpErrorResponse } from "@/lib/ahp/api-error";
import { validateLocalMutationRequest } from "@/lib/http/local-mutation";


export async function GET(request: NextRequest) {
  const hostUrl = request.nextUrl.searchParams.get("host");

  if (!hostUrl) {
    return NextResponse.json({ sessions: [] });
  }

  let connection: Awaited<ReturnType<typeof connectInitializedAhpClient>>;
  try {
    connection = await connectInitializedAhpClient(hostUrl);
  } catch (err) {
    return ahpErrorResponse(err, "Failed to connect to AHP host");
  }

  const { client, initialized, diagnostics } = connection;

  try {
    const allSessions = await listAllSessions(client);
    const sessions: AHPSessionSummary[] = allSessions
      .filter((s) => shouldShowSession(s.status, s.changes?.files ?? 0))
      .map(mapSdkSessionSummary);

    await client.shutdown();
    return NextResponse.json({
      sessions,
      connection: {
        ...diagnostics,
        protocolVersion: initialized.protocolVersion,
        totalSessions: allSessions.length,
        visibleSessions: sessions.length,
        filteredSessions: allSessions.length - sessions.length,
      },
    });
  } catch (err) {
    await client.shutdown().catch(() => {});
    return ahpErrorResponse(err, "Failed to list sessions");
  }
}

export async function POST(request: NextRequest) {
  const requestError = validateLocalMutationRequest(request);
  if (requestError) {
    return NextResponse.json({ error: requestError }, { status: 403 });
  }

  try {
    const input = parseCreationRequest(await request.json(), true);
    const streaming = request.headers.get("accept")?.includes("application/x-ndjson");
    if (!streaming) {
      const result = await runTaskCreation(input, () => {});
      return NextResponse.json(result, { status: result.outcome === "invalid" ? 409 : ["started", "queued"].includes(result.outcome) ? 200 : 502 });
    }
    const encoder = new TextEncoder();
    let disconnected = false;
    const stream = new ReadableStream({
      start(controller) {
        const emit = (event: TaskCreationEvent) => {
          if (!disconnected) controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        };
        // Disconnecting the browser must not abandon a possibly-created session or retry it.
        void Promise.resolve().then(() => runTaskCreation(input, emit)).then(
          (result) => emit(result),
          (err) => emit({ type: "result", outcome: "invalid", error: err instanceof Error ? err.message : "Task setup failed" }),
        ).finally(() => { if (!disconnected) controller.close(); });
      },
      cancel() { disconnected = true; },
    });
    return new Response(stream, { headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store", "X-Accel-Buffering": "no" } });
  } catch (err) {
    if (err instanceof CreationConfigError || err instanceof SyntaxError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    return ahpErrorResponse(err, "Failed to create session");
  }
}
