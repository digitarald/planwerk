import { NextRequest, NextResponse } from "next/server";
import { AhpClient } from "@tylerl0706/ahpx";

import { mockAHPSessions } from "@/lib/ahp/mock-sessions";
import { AHPSessionSummary, AHPStatus } from "@/lib/ahp/types";

export async function GET(request: NextRequest) {
  const hostUrl = request.nextUrl.searchParams.get("host");

  if (!hostUrl) {
    return NextResponse.json({ sessions: mockAHPSessions });
  }

  try {
    const client = new AhpClient({ initialSubscriptions: ["ahp-root://"] });
    await client.connect(hostUrl);

    const result = await client.listSessions();
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
        if (s.changesets && s.changesets.length > 0) {
          let additions = 0;
          let deletions = 0;
          for (const edit of s.changesets) {
            if (edit.diff) {
              additions += edit.diff.added ?? 0;
              deletions += edit.diff.removed ?? 0;
            }
          }
          mapped.changes = { additions, deletions, files: s.changesets.length };
        }
        return mapped;
      });

    client.disconnect();
    return NextResponse.json({ sessions });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to connect to AHP host";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
