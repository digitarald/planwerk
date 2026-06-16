import { NextRequest, NextResponse } from "next/server";
import { AhpClient } from "@microsoft/agent-host-protocol/client";
import { WebSocketTransport } from "@microsoft/agent-host-protocol/ws";
import { SUPPORTED_PROTOCOL_VERSIONS } from "@microsoft/agent-host-protocol";

import { mockAHPSessions } from "@/lib/ahp/mock-sessions";
import { AHPSessionSummary, AHPStatus } from "@/lib/ahp/types";

export async function GET(request: NextRequest) {
  const hostUrl = request.nextUrl.searchParams.get("host");

  if (!hostUrl) {
    return NextResponse.json({ sessions: mockAHPSessions });
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
      protocolVersions: SUPPORTED_PROTOCOL_VERSIONS,
      initialSubscriptions: [],
    });

    const result = await client.request("listSessions", { channel: "ahp-root://" });
    const sessions: AHPSessionSummary[] = result.items
      .filter((s) => !(s.status & AHPStatus.IsArchived))
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
        if (s.model) mapped.model = s.model.id;
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
