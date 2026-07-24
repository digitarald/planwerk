import { NextRequest, NextResponse } from "next/server";
import { AhpClient } from "@microsoft/agent-host-protocol/client";

import { AHPSessionSummary, shouldShowSession } from "@/lib/ahp/types";
import { listAllSessions } from "@/lib/ahp/catalog";
import { connectAhpTransport } from "@/lib/ahp/endpoint";
import { sessionWorkingDirectories } from "@/lib/ahp/working-directories";
import { initializeAhpClient } from "@/lib/ahp/initialize";
import { injectMessage } from "@/lib/ahp/session-messenger";
import { ahpErrorResponse } from "@/lib/ahp/api-error";

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

  let endpoint: Awaited<ReturnType<typeof connectAhpTransport>>;
  try {
    endpoint = await connectAhpTransport(hostUrl);
  } catch (err) {
    return ahpErrorResponse(err, "Failed to connect to AHP host");
  }

  const client = new AhpClient(endpoint.transport);
  client.connect();

  try {
    const initialized = await initializeAhpClient(client);

    const allSessions = await listAllSessions(client);
    const sessions: AHPSessionSummary[] = allSessions
      .filter((s) => shouldShowSession(s.status, s.changes?.files ?? 0))
      .map((s) => {
        const mapped: AHPSessionSummary = {
          resource: s.resource,
          provider: s.provider,
          title: s.title,
          status: s.status,
          createdAt: new Date(s.createdAt).toISOString(),
          modifiedAt: new Date(s.modifiedAt).toISOString(),
        };
        if (s.activity) mapped.activity = s.activity;
        if (s.project) mapped.project = { name: s.project.displayName, path: s.project.uri };
        if (s.workingDirectory) mapped.workingDirectory = s.workingDirectory;
        const workingDirectories = sessionWorkingDirectories(s);
        if (workingDirectories) mapped.workingDirectories = workingDirectories;
        if (s.changes) {
          mapped.changes = {
            additions: s.changes.additions ?? 0,
            deletions: s.changes.deletions ?? 0,
            files: s.changes.files ?? 0,
          };
        }
        return mapped;
      });

    await client.shutdown();
    return NextResponse.json({
      sessions,
      connection: {
        ...endpoint.diagnostics,
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
    const { getAHPClient, releaseAHPClient } = await import("@/lib/ahp/client-manager");
    const client = await getAHPClient(hostUrl);
    const sessionId = crypto.randomUUID();
    // The session URI scheme must match the provider so the host routes it to
    // the right agent (e.g. `copilotcli:/<uuid>`).
    const channel = `${agentProvider}:/${sessionId}`;

    try {
      // Model selection is provider-defined session config in AHP 0.5 (no longer a
      // top-level createSession field); the provider applies its default here and
      // the selection is surfaced from SessionState.config afterwards.
      await client.request("createSession", {
        channel,
        provider: agentProvider,
        workingDirectory: workingDirectory || undefined,
        config: NEW_SESSION_CONFIG,
      });
    } finally {
      releaseAHPClient(hostUrl);
    }

    // Deliver the task as the first message so the planning turn starts.
    // injectMessage manages its own client lifecycle and flushes via ping.
    const delivered = await injectMessage(hostUrl, channel, task);
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
