// This repo does not have tsx installed; package.json runs this with Node 24's
// built-in TypeScript stripping via `node --experimental-strip-types`.
import { randomUUID } from "node:crypto";

import type {
  ChatState,
  SessionChatInputRequest,
  SessionInputRequest,
  SessionState,
  SessionSummary,
  Snapshot,
  Turn,
} from "@microsoft/agent-host-protocol";
import { AhpClient } from "@microsoft/agent-host-protocol/client";

import { chatQueuedMessage, chatTurnStarted } from "../lib/ahp/actions.ts";
import { connectAhpTransport } from "../lib/ahp/endpoint.ts";
import { LOCAL_DESKTOP_HOST } from "../lib/ahp/endpoint-config.ts";
import { initializeAhpClient } from "../lib/ahp/initialize.ts";
import { readProtocolCompatibilityError } from "../lib/ahp/protocol-rpc.ts";
import { AHPStatus, parseAHPStatus } from "../lib/ahp/types.ts";

const ROOT_CHANNEL = "ahp-root://" as const;
const WRITE_ENABLED = process.env.AHP_SMOKE_WRITE === "1";

type SnapshotReaders = {
  readSessionState: (client: AhpClient, sessionUri: string) => Promise<SessionState | undefined>;
  readChatState: (client: AhpClient, chatUri: string) => Promise<ChatState | undefined>;
};

function log(message: string) {
  console.log(`[ahp-smoke] ${message}`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatStatus(status: number): string {
  const parsed = parseAHPStatus(status);
  const labels = [
    parsed.isIdle ? "idle" : null,
    parsed.isError ? "error" : null,
    parsed.isInProgress ? "in-progress" : null,
    parsed.isInputNeeded ? "input-needed" : null,
    parsed.isRead ? "read" : null,
    parsed.isArchived ? "archived" : null,
  ].filter((label): label is string => Boolean(label));

  return labels.length > 0 ? `${status} (${labels.join(", ")})` : `${status} (none)`;
}

function oneLine(value: string | undefined): string {
  return (value ?? "(untitled)").replace(/\s+/g, " ").trim();
}

function asSessionState(snapshot: Snapshot | undefined): SessionState | undefined {
  // Session channels use the provider scheme (e.g. `copilotcli:/…`), not the
  // canonical `ahp-session:` scheme — narrow on shape (`chats` is unique to
  // SessionState). Mirrors lib/ahp/snapshot.ts.
  const state = snapshot?.state;
  if (!state || !Array.isArray((state as Partial<SessionState>).chats)) return undefined;
  return state as SessionState;
}

function asChatState(snapshot: Snapshot | undefined): ChatState | undefined {
  if (!snapshot?.resource.startsWith("ahp-chat:")) return undefined;
  return snapshot.state as ChatState;
}

async function readSessionStateLocal(
  client: AhpClient,
  sessionUri: string,
): Promise<SessionState | undefined> {
  const { result, subscription } = await client.subscribe(sessionUri);
  void subscription.close();
  await client.unsubscribe(sessionUri).catch(() => {});
  return asSessionState(result.snapshot);
}

async function readChatStateLocal(
  client: AhpClient,
  chatUri: string,
): Promise<ChatState | undefined> {
  const { result, subscription } = await client.subscribe(chatUri);
  void subscription.close();
  await client.unsubscribe(chatUri).catch(() => {});
  return asChatState(result.snapshot);
}

async function loadSnapshotReaders(): Promise<SnapshotReaders> {
  try {
    const snapshot = await import("../lib/ahp/snapshot.ts");
    log("using Planwerk snapshot helpers from lib/ahp/snapshot.ts");
    return {
      readSessionState: snapshot.readSessionState,
      readChatState: snapshot.readChatState,
    };
  } catch (error) {
    log(
      `Planwerk snapshot helpers unavailable in standalone Node (${errorMessage(error)}); using equivalent one-shot snapshot readers.`,
    );
    return {
      readSessionState: readSessionStateLocal,
      readChatState: readChatStateLocal,
    };
  }
}

async function connect(hostUrl: string): Promise<{ client: AhpClient; protocolVersion: string }> {
  const { transport, diagnostics } = await connectAhpTransport(hostUrl);
  const client = new AhpClient(transport);
  client.connect();

  try {
    const init = await initializeAhpClient(client, {
      clientId: randomUUID(),
    });

    log(
      `connected via ${diagnostics.transport} (${diagnostics.resolvedTarget}); `
      + `${diagnostics.candidateCount} local candidate(s) considered.`,
    );
    return { client, protocolVersion: init.protocolVersion };
  } catch (error) {
    await client.shutdown().catch(() => {});
    throw error;
  }
}

function validateHostUrl(hostUrl: string) {
  if (hostUrl === LOCAL_DESKTOP_HOST) return;
  const parsed = new URL(hostUrl);
  if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
    throw new Error(`AHP_SMOKE_HOST must be vscode-local://desktop, ws://, or wss://, got ${hostUrl}`);
  }
}

function printSessionSummaries(sessions: SessionSummary[]) {
  log(`listSessions returned ${sessions.length} session(s).`);
  for (const [index, session] of sessions.slice(0, 5).entries()) {
    log(
      `session[${index}] ${session.resource} title="${oneLine(session.title)}" status=${formatStatus(session.status)}`,
    );
  }
  if (sessions.length > 5) {
    log(`... ${sessions.length - 5} more session(s) not shown.`);
  }
}

function describeInput(input: SessionInputRequest): string {
  if (input.kind === "chatInput") {
    return `chatInput id=${input.request.id} chat=${input.chat} questions=${input.request.questions?.length ?? 0}`;
  }
  if (input.kind === "toolConfirmation") {
    return `toolConfirmation id=${input.id} chat=${input.chat} turn=${input.turnId} toolCall=${input.toolCall.toolCallId}`;
  }
  return `toolClientExecution id=${input.id} chat=${input.chat} turn=${input.turnId} client=${input.clientId} toolCall=${input.toolCall.toolCallId}`;
}

function chatInputRequests(inputs: SessionInputRequest[] | undefined): SessionChatInputRequest[] {
  return (inputs ?? []).filter((input): input is SessionChatInputRequest => input.kind === "chatInput");
}

function isClearlySmokeSession(summary: SessionSummary, state: SessionState | undefined): boolean {
  const haystack = `${summary.resource} ${summary.title} ${state?.title ?? ""}`.toLowerCase();
  return haystack.includes("smoke") || haystack.includes("test");
}

function printInputNeeded(inputNeeded: SessionInputRequest[] | undefined) {
  if (!inputNeeded || inputNeeded.length === 0) {
    log("inputNeeded: none.");
    return;
  }

  log(`inputNeeded: ${inputNeeded.length} request(s).`);
  for (const input of inputNeeded) {
    log(`inputNeeded ${describeInput(input)}`);
  }
}

function printChatState(chatState: ChatState | undefined) {
  if (!chatState) {
    log("defaultChat snapshot unavailable.");
    return;
  }

  const turns: Turn[] = chatState.turns ?? [];
  log(`defaultChat ${chatState.resource} has ${turns.length} turn(s); turnsNextCursor=${chatState.turnsNextCursor ? "yes" : "no"}.`);
}

async function maybeWriteSmokeTurn(
  client: AhpClient,
  readers: SnapshotReaders,
  sessionState: SessionState,
) {
  if (!WRITE_ENABLED) {
    log("AHP_SMOKE_WRITE is not 1 — skipping mutating protocol steps.");
    return;
  }

  const chatUri = sessionState.defaultChat;
  if (!chatUri) {
    log("AHP_SMOKE_WRITE=1 but no defaultChat is available; skipping message injection.");
    return;
  }

  const turnId = randomUUID();
  const startedAt = new Date().toISOString();
  const text = `Planwerk AHP smoke test ping (${startedAt})`;
  const status = Number(sessionState.status);
  const inProgress = parseAHPStatus(status).isInProgress;

  if (inProgress) {
    client.dispatch(chatUri, chatQueuedMessage(turnId, text));
    log(`AHP_SMOKE_WRITE=1 queued benign smoke message ${turnId}.`);
  } else {
    client.dispatch(chatUri, chatTurnStarted(turnId, text, startedAt));
    log(`AHP_SMOKE_WRITE=1 started benign smoke turn ${turnId} at ${startedAt}.`);
  }

  await client.ping();
  const updatedChatState = await readers.readChatState(client, chatUri);
  log(`after write ping, defaultChat has ${updatedChatState?.turns?.length ?? 0} turn(s).`);
}

async function maybePrintAnswerInputNotice(
  summary: SessionSummary,
  sessionState: SessionState | undefined,
) {
  const chatInputs = chatInputRequests(sessionState?.inputNeeded);
  if (chatInputs.length === 0) return;

  const smokeSession = sessionState ? isClearlySmokeSession(summary, sessionState) : false;
  if (!WRITE_ENABLED) {
    log("chatInput request(s) found; not answering because AHP_SMOKE_WRITE is not 1.");
    return;
  }

  if (!smokeSession) {
    log("chatInput request(s) found; not answering because the selected session is not clearly a smoke/test session.");
    return;
  }

  log("chatInput request(s) found on a smoke/test session; leaving them unanswered for operator review.");
}

async function run() {
  const hostUrl = process.env.AHP_SMOKE_HOST;
  if (!hostUrl) {
    log("AHP_SMOKE_HOST not set — skipping runtime smoke.");
    return;
  }

  validateHostUrl(hostUrl);

  let client: AhpClient | undefined;
  try {
    log(`connecting to ${hostUrl}`);
    const connection = await connect(hostUrl);
    client = connection.client;
    log(`connected and initialized; protocol=${connection.protocolVersion}.`);

    const readers = await loadSnapshotReaders();
    const listResult = await client.request("listSessions", { channel: ROOT_CHANNEL });
    printSessionSummaries(listResult.items);

    const firstSession = listResult.items[0];
    if (!firstSession) {
      await client.ping();
      log("PASS: initialized connection, pinged host, and listed an empty session catalog.");
      return;
    }

    const sessionState = await readers.readSessionState(client, firstSession.resource);
    if (!sessionState) {
      throw new Error(`No SessionState snapshot returned for ${firstSession.resource}`);
    }

    log(`selected ${firstSession.resource} title="${oneLine(firstSession.title)}".`);
    log(`session status=${formatStatus(Number(sessionState.status))}; defaultChat=${sessionState.defaultChat ?? "(none)"}.`);
    log(`session archived=${(Number(sessionState.status) & AHPStatus.IsArchived) !== 0 ? "yes" : "no"} (left unchanged).`);
    printInputNeeded(sessionState.inputNeeded);
    await maybePrintAnswerInputNotice(firstSession, sessionState);

    const chatState = sessionState.defaultChat
      ? await readers.readChatState(client, sessionState.defaultChat)
      : undefined;
    printChatState(chatState);

    await maybeWriteSmokeTurn(client, readers, sessionState);
    await client.ping();

    log("PASS: initialized connection, listed sessions, read SessionState, read ChatState turns, and verified ping.");
  } finally {
    if (client) {
      await client.shutdown().catch((error) => {
        log(`shutdown warning: ${errorMessage(error)}`);
      });
      log("client shutdown complete.");
    }
  }
}

run().catch((error) => {
  const compatibilityError = readProtocolCompatibilityError(error);
  if (compatibilityError) {
    console.error(
      `[ahp-smoke] protocol mismatch (${compatibilityError.relation}); `
      + `host=${compatibilityError.hostSupportedVersions.join(", ") || "not provided"}; `
      + `planwerk=${compatibilityError.offeredVersions.join(", ")}`,
    );
  }
  console.error(`[ahp-smoke] FAIL: ${errorMessage(error)}`);
  process.exitCode = 1;
});
