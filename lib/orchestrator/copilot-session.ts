import type { CopilotClient, CopilotSession } from "@github/copilot-sdk";

type SessionOwner = Pick<CopilotClient, "deleteSession">;
type DisposableSession = Pick<CopilotSession, "sessionId" | "abort" | "disconnect">;

export async function disposeOneShotSession(
  client: SessionOwner,
  session: DisposableSession,
  abortInFlight: boolean,
  logPrefix: string
): Promise<void> {
  if (abortInFlight) {
    try {
      await session.abort();
    } catch (error) {
      console.warn(
        `${logPrefix} Failed to abort Copilot SDK session:`,
        error instanceof Error ? error.message : error
      );
    }
  }

  try {
    await client.deleteSession(session.sessionId);
  } catch (error) {
    console.warn(
      `${logPrefix} Failed to delete Copilot SDK session:`,
      error instanceof Error ? error.message : error
    );
    try {
      await session.disconnect();
    } catch (disconnectError) {
      console.warn(
        `${logPrefix} Failed to disconnect Copilot SDK session:`,
        disconnectError instanceof Error ? disconnectError.message : disconnectError
      );
    }
  }
}
