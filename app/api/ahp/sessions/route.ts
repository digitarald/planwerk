import { NextRequest, NextResponse } from "next/server";
import { AHPSessionSummary, shouldShowSession } from "@/lib/ahp/types";
import { listAllSessions } from "@/lib/ahp/catalog";
import { connectInitializedAhpClient } from "@/lib/ahp/endpoint";
import { mapSdkSessionSummary } from "@/lib/ahp/session-summary";
import { createAndStartSession } from "@/lib/ahp/create-session";
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

  const { hostUrl, title, prompt, provider, workingDirectory } =
    (await request.json()) as {
      hostUrl?: string;
      title?: string;
      prompt?: string;
      provider?: string;
      workingDirectory?: string;
    };

  if (!hostUrl) {
    return NextResponse.json({ error: "hostUrl required" }, { status: 400 });
  }

  // The task description doubles as the title and the first message. Accept
  // either field; the agent host derives the real session title from the
  // first message, so `title` is just a fallback label for the response.
  const task = (prompt ?? title ?? "").trim();
  if (!task) {
    return NextResponse.json({ error: "task description required" }, { status: 400 });
  }

  try {
    const delivered = await createAndStartSession({
      hostUrl, task, provider: provider || undefined, workingDirectory,
    });
    if (!delivered.success) {
      return NextResponse.json(
        { error: "Session created but failed to start the task" },
        { status: 502 }
      );
    }

    return NextResponse.json({ resource: delivered.resource, title: title ?? task });
  } catch (err) {
    return ahpErrorResponse(err, "Failed to create session");
  }
}
