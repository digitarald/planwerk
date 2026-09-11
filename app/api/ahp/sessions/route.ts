import { NextRequest, NextResponse } from "next/server";
import { AHPSessionSummary, shouldShowSession } from "@/lib/ahp/types";
import { listAllSessions } from "@/lib/ahp/catalog";
import { connectInitializedAhpClient } from "@/lib/ahp/endpoint";
import { withAHPClient } from "@/lib/ahp/client-operation";
import { mapSdkSessionSummary } from "@/lib/ahp/session-summary";
import { injectMessageWithClient } from "@/lib/ahp/session-messenger";
import { ahpErrorResponse } from "@/lib/ahp/api-error";
import { validateLocalMutationRequest } from "@/lib/http/local-mutation";

/** Default agent provider for new sessions on this host. */
const DEFAULT_PROVIDER = "copilotcli";

/**
 * Session config applied to every new task:
 * - `mode: "plan"` — the agent plans first and asks clarifying questions
 *   before writing code (surfaced on the board as input requests).
 * - `autoApprove: "autoApprove"` — bypass per-tool approval prompts so the
 *   session can proceed autonomously once the plan is accepted.
 */
const NEW_SESSION_CONFIG = { mode: "plan", autoApprove: "autoApprove" } as const;

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

  const agentProvider = provider || DEFAULT_PROVIDER;

  try {
    const sessionId = crypto.randomUUID();
    // The session URI scheme must match the provider so the host routes it to
    // the right agent (e.g. `copilotcli:/<uuid>`).
    const channel = `${agentProvider}:/${sessionId}`;

    const delivered = await withAHPClient(hostUrl, async (client) => {
      // Model selection is provider-defined session config (not a
      // top-level createSession field); the provider applies its default here and
      // the selection is surfaced from SessionState.config afterwards.
      await client.request("createSession", {
        channel,
        provider: agentProvider,
        workingDirectories: workingDirectory ? [workingDirectory] : undefined,
        config: NEW_SESSION_CONFIG,
      });
      return injectMessageWithClient(client, channel, task);
    });
    if (!delivered.success) {
      return NextResponse.json(
        { error: "Session created but failed to start the task" },
        { status: 502 }
      );
    }

    return NextResponse.json({ resource: channel, title: title ?? task });
  } catch (err) {
    return ahpErrorResponse(err, "Failed to create session");
  }
}
