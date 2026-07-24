import type { SessionSummary } from "@microsoft/agent-host-protocol";
import type { AhpClient } from "@microsoft/agent-host-protocol/client";

/** Read the complete root session catalogue, following every cursor page. */
export async function listAllSessions(client: AhpClient): Promise<SessionSummary[]> {
  const sessions: SessionSummary[] = [];
  let cursor: string | undefined;

  do {
    const page = await client.request("listSessions", {
      channel: "ahp-root://",
      cursor,
    });
    sessions.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);

  return sessions;
}
