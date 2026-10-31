import "server-only";
import { randomUUID } from "node:crypto";
import type { ModelSelection, ProgressParams } from "@microsoft/agent-host-protocol";
import { AhpErrorCodes } from "@microsoft/agent-host-protocol";
import { RpcError, type AhpClient, type AhpTransport } from "@microsoft/agent-host-protocol/client";
import { connectInitializedAhpClient } from "./endpoint";
import { resolveCreationConfiguration, creationRevision, CreationConfigError } from "./session-config";
import { withSessionState } from "./snapshot";
import { assertDefaultChatWritable } from "./chat-facts";
import { chatQueuedMessage, chatTurnStarted } from "./actions";
import { parseAHPStatus } from "./types";
import { dispatchAndConfirm, MessageDispatchAmbiguousError } from "./dispatch-confirmation";

export type TaskCreationEvent =
  | { type: "stage"; stage: "connecting" | "validating" | "creating" | "sending" }
  | { type: "progress"; progress: ProgressParams }
  | { type: "result"; resource?: string; outcome: "started" | "queued" | "prompt-failed" | "prompt-uncertain" | "creation-uncertain" | "setup-failed" | "creation-failed" | "invalid"; error?: string };

export interface TaskCreationInput {
  requestId: string;
  hostUrl: string;
  provider?: string;
  workingDirectory: string;
  config?: Record<string, unknown>;
  model?: ModelSelection;
  revision?: string;
  prompt?: string;
  title?: string;
}

// The published client's event union omits progress; observe the typed wire frame without consuming it.
export function creationProgressTransport(transport: AhpTransport, token: string, notify: (event: TaskCreationEvent) => void): AhpTransport {
  return {
    send: (message) => transport.send(message),
    close: () => transport.close(),
    async recv() {
      const frame = await transport.recv();
      try {
        const message = frame?.kind === "parsed" ? frame.message :
          frame?.kind === "text" ? JSON.parse(frame.text) :
          frame?.kind === "binary" ? JSON.parse(new TextDecoder().decode(frame.data)) : undefined;
        if (message?.method === "progress" && message.id === undefined) {
          const params = message.params as ProgressParams;
          if (params.progressToken === token && typeof params.progress === "number" && Number.isFinite(params.progress) && params.progress >= 0) {
            notify({ type: "progress", progress: params });
          }
        }
      } catch { /* Let the protocol client handle malformed frames. */ }
      return frame;
    },
  };
}

async function sendInitialTask(client: AhpClient, resource: string, task: string, model?: ModelSelection) {
  return withSessionState(client, resource, async (state, access) => {
    if (!state?.defaultChat) return { success: false, queued: false };
    await assertDefaultChatWritable(client, state);
    access.assertCurrent();
    const current = access.getState();
    if (current?.defaultChat !== state.defaultChat) throw new Error("The default chat changed during setup.");
    const queued = parseAHPStatus(current.status).isInProgress;
    const id = randomUUID();
    const action = queued ? chatQueuedMessage(id, task) : chatTurnStarted(id, task);
    // ModelSelection belongs to Message in the published protocol, not CreateSessionParams.
    if (model) action.message.model = model;
    await dispatchAndConfirm(client, state.defaultChat, action, "The initial task may have been sent before the connection failed.");
    return { success: true, queued };
  });
}

export async function performTaskCreation(input: TaskCreationInput, notify: (event: TaskCreationEvent) => void): Promise<TaskCreationEvent & { type: "result" }> {
  let client: AhpClient | undefined;
  let resource: string | undefined;
  let stage = "connecting";
  let created = false;
  let setupProgress = false;
  const token = randomUUID();
  const emit = (event: TaskCreationEvent) => { if (event.type === "progress") setupProgress = true; notify(event); };
  try {
    emit({ type: "stage", stage: "connecting" });
    ({ client } = await connectInitializedAhpClient(input.hostUrl, {
      requestTimeoutMs: 180_000,
      wrapTransport: (transport) => creationProgressTransport(transport, token, emit),
    }));
    stage = "validating";
    emit({ type: "stage", stage: "validating" });
    const resolved = await resolveCreationConfiguration(client, { ...input, strict: true });
    if (input.revision && input.revision !== resolved.revision) throw new CreationConfigError("Task options changed on the host. Refresh task options before creating.");
    if (!input.revision && (input.config || input.model)) throw new CreationConfigError("Refresh task options before creating.");
    resource = `ahp-session:/${input.requestId}`;
    stage = "creating";
    emit({ type: "stage", stage: "creating" });
    await client.request("createSession", {
      channel: resource, provider: resolved.provider, workingDirectories: [input.workingDirectory],
      config: resolved.values, progressToken: token,
    });
    created = true;
    stage = "sending";
    emit({ type: "stage", stage: "sending" });
    const delivery = await sendInitialTask(client, resource, input.prompt?.trim() || input.title?.trim() || "", resolved.model);
    return { type: "result", resource, outcome: delivery.success ? delivery.queued ? "queued" : "started" : "prompt-failed",
      ...(!delivery.success ? { error: "Session created, but its chat is not ready. Open the session to send the task; do not create it again." } : {}) };
  } catch (err) {
    const error = err instanceof Error ? err.message : "Task setup failed.";
    if (created) {
      const uncertain = err instanceof MessageDispatchAmbiguousError;
      return { type: "result", resource, outcome: uncertain ? "prompt-uncertain" : "prompt-failed",
        error: `Session created. ${uncertain ? "Task delivery is uncertain; check the conversation before sending again." : "The task could not be sent; open this session to send it."} ${error}` };
    }
    if (err instanceof CreationConfigError) return { type: "result", outcome: "invalid", error };
    if (stage === "creating" && err instanceof RpcError && err.code === AhpErrorCodes.SessionAlreadyExists) {
      return { type: "result", resource, outcome: "creation-uncertain", error: "This session already exists. Open it and check whether the task was delivered; creation will not be retried." };
    }
    if (stage === "creating" && !(err instanceof RpcError)) return { type: "result", resource, outcome: "creation-uncertain", error: `${error} Creation may have succeeded. Check the board before starting another task.` };
    const outcome = stage === "creating" ? setupProgress ? "setup-failed" : "creation-failed" : "setup-failed";
    return { type: "result", outcome, error: `${outcome === "setup-failed" ? "Session setup" : "Session creation"} failed: ${error}` };
  } finally {
    await client?.shutdown().catch(() => {});
  }
}

interface CreationAttempt {
  fingerprint: string;
  result: Promise<TaskCreationEvent & { type: "result" }>;
}
const attempts = new Map<string, CreationAttempt>();

/** Replays a submitted attempt, never repeats its create/initial-prompt side effects. */
export function runTaskCreation(input: TaskCreationInput, notify: (event: TaskCreationEvent) => void) {
  const key = `${input.hostUrl}:${input.requestId}`;
  const fingerprint = creationRevision(input);
  const previous = attempts.get(key);
  if (previous) {
    if (previous.fingerprint !== fingerprint) throw new CreationConfigError("This task attempt was already submitted with different options.");
    return previous.result;
  }
  // shortcut: process-local attempt ledger; durable cross-restart recovery needs a persisted operation record.
  if (attempts.size >= 512) throw new CreationConfigError("Task attempt history is full. Restart Planwerk after checking pending tasks.");
  const result = Promise.resolve().then(() => performTaskCreation(input, notify));
  attempts.set(key, { fingerprint, result });
  return result;
}
