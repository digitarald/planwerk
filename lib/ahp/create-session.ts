import { randomUUID } from "node:crypto";
import { withAHPClient } from "./client-operation";
import { injectMessageWithClient } from "./session-messenger";
import { assertOperationCurrent, runOperationEffect } from "../orchestrator/operation-context";

export async function createAndStartSession(options: {
  hostUrl: string;
  task: string;
  workingDirectory?: string;
  provider?: string;
  resource?: string;
  signal?: AbortSignal;
  beforeStart?: () => void;
  beforeDispatch?: Parameters<typeof injectMessageWithClient>[4];
}) {
  const provider = options.provider ?? "copilotcli";
  const resource = options.resource ?? `${provider}:/${randomUUID()}`;
  return withAHPClient(options.hostUrl, async (client) => {
    assertOperationCurrent("interact");
    await runOperationEffect("interact", () => client.request("createSession", {
      channel: resource,
      provider,
      workingDirectories: options.workingDirectory ? [options.workingDirectory] : undefined,
      config: { mode: "plan", autoApprove: "autoApprove" },
    }));
    options.beforeStart?.();
    const delivery = await injectMessageWithClient(client, resource, options.task, options.signal, options.beforeDispatch);
    return { resource, ...delivery };
  }, options.signal);
}
