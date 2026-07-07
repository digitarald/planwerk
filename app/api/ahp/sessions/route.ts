import { NextRequest, NextResponse } from "next/server";
import { AhpClient } from "@microsoft/agent-host-protocol/client";
import { WebSocketTransport } from "@microsoft/agent-host-protocol/ws";

import { AHPSessionSummary, shouldShowSession } from "@/lib/ahp/types";
import { OFFERED_PROTOCOL_VERSIONS } from "@/lib/ahp/protocol";
import { injectMessage } from "@/lib/ahp/session-messenger";

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

  let transport: Awaited<ReturnType<typeof WebSocketTransport.connect>>;
  try {
    transport = await WebSocketTransport.connect(hostUrl);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to connect to AHP host";
    return NextResponse.json({ error: message }, { status: 502 });
  }

  const client = new AhpClient(transport);
  client.connect();

  try {
    await client.initialize({
      clientId: crypto.randomUUID(),
      protocolVersions: OFFERED_PROTOCOL_VERSIONS,
      initialSubscriptions: [],
    });

    const result = await client.request("listSessions", { channel: "ahp-root://" });
    const sessions: AHPSessionSummary[] = result.items
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
    return NextResponse.json({ sessions });
  } catch (err) {
    await client.shutdown().catch(() => {});
    const message = err instanceof Error ? err.message : "Failed to list sessions";
    return NextResponse.json({ error: message }, { status: 502 });
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
    const message = err instanceof Error ? err.message : "Failed to create session";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
