import { connect as connectSocket } from "node:net";

import type { InitializeResult } from "@microsoft/agent-host-protocol";
import {
  AhpClient,
  TransportError,
  type AhpTransport,
  type JsonRpcMessage,
  type TransportFrame,
} from "@microsoft/agent-host-protocol/client";
import WebSocket, { type RawData } from "ws";
import { awaitAbortable, awaitWithTimeout, OperationAbortedError, throwIfAborted } from "../abort.ts";

import { listAllSessions } from "./catalog.ts";
import { LOCAL_DESKTOP_HOST } from "./endpoint-config.ts";
import { discoverLocalEditorEndpoints } from "./local-endpoint-registry.ts";
import {
  connectInitializedClient,
  type InitializeAhpClientOptions,
} from "./initialize.ts";
import {
  aggregateIncompatibleProtocolVersions,
  allDesktopCandidatesProtocolIncompatible,
  selectDesktopSocket,
  type DesktopSocketProbe,
} from "./endpoint-selection.ts";
import { OFFERED_PROTOCOL_VERSIONS, ProtocolCompatibilityError } from "./protocol.ts";
import { readProtocolCompatibilityError } from "./protocol-rpc.ts";

const DISCOVERY_TTL_MS = 30_000;
const CONNECT_TIMEOUT_MS = 15_000;

interface PendingRead {
  resolve(value: TransportFrame | null): void;
  reject(error: Error): void;
}

export interface AhpEndpointDiagnostics {
  logicalUrl: string;
  transport: "named-pipe-websocket" | "unix-websocket" | "websocket";
  resolvedTarget: string;
  candidateCount: number;
  compatibleCandidateCount: number;
  selectedSessionCount?: number;
  selectionReason?: string;
}

export interface ConnectedAhpTransport {
  transport: AhpTransport;
  diagnostics: AhpEndpointDiagnostics;
}

export interface ConnectedAhpClient {
  client: AhpClient;
  initialized: InitializeResult;
  diagnostics: AhpEndpointDiagnostics;
}

export interface ConnectAhpClientOptions extends InitializeAhpClientOptions {
  signal?: AbortSignal;
  requestTimeoutMs?: number;
  wrapTransport?: (transport: AhpTransport) => AhpTransport;
}

interface CachedDesktopSelection {
  selected: DesktopSocketProbe;
  candidateCount: number;
  compatibleCandidateCount: number;
  expiresAt: number;
}

interface DesktopSocketProbeOutcome {
  probe?: DesktopSocketProbe;
  incompatibility?: ReturnType<typeof readProtocolCompatibilityError>;
}

let cachedDesktopSelection: CachedDesktopSelection | undefined;
let pendingDesktopSelection: Promise<CachedDesktopSelection> | undefined;

class NodeWebSocketTransport implements AhpTransport {
  private readonly inbox: Array<TransportFrame | null> = [];
  private readonly waiters: PendingRead[] = [];
  private readonly socket: WebSocket;
  private error: TransportError | undefined;
  private closed = false;

  static connect(
    url: URL,
    signal?: AbortSignal,
    socketPath?: string,
  ): Promise<NodeWebSocketTransport> {
    throwIfAborted(signal);
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url, {
        ...(socketPath ? { createConnection: () => connectSocket(socketPath) } : {}),
      });
      const timer = setTimeout(() => {
        reject(new TransportError("io", "AHP websocket connection timed out"));
        socket.terminate();
      }, CONNECT_TIMEOUT_MS);
      const onAbort = () => {
        reject(new OperationAbortedError(signal?.reason));
        socket.terminate();
      };

      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        socket.off("open", onOpen);
        socket.off("error", onError);
        socket.off("close", onClose);
      };
      const onOpen = () => {
        cleanup();
        resolve(new NodeWebSocketTransport(socket));
      };
      const onError = (cause: Error) => {
        reject(new TransportError("io", `AHP websocket failed to open: ${cause.message}`, { cause }));
      };
      const onClose = (code: number) => {
        cleanup();
        reject(new TransportError("closed", `desktop websocket closed before open (code=${code})`));
      };

      socket.once("open", onOpen);
      socket.on("error", onError);
      socket.once("close", onClose);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.on("message", (data: RawData) => {
      const text = typeof data === "string" ? data : data.toString();
      this.deliver({ kind: "text", text });
    });
    socket.on("error", (cause) => {
      this.error = new TransportError("io", `desktop websocket error: ${cause.message}`, { cause });
      this.drainWithError(this.error);
    });
    socket.on("close", (code) => {
      this.closed = true;
      if (code === 1000) {
        this.drainWithNull();
      } else {
        this.error = new TransportError("closed", `desktop websocket closed abnormally (code=${code})`);
        this.drainWithError(this.error);
      }
    });
  }

  send(message: JsonRpcMessage | string): void {
    if (this.error) throw this.error;
    if (this.closed || this.socket.readyState !== WebSocket.OPEN) {
      throw new TransportError("closed", "desktop websocket is closed");
    }
    this.socket.send(typeof message === "string" ? message : JSON.stringify(message));
  }

  recv(): Promise<TransportFrame | null> {
    if (this.error) return Promise.reject(this.error);
    const queued = this.inbox.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    if (this.closed) return Promise.resolve(null);
    return new Promise((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }

  close(): void {
    if (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING) {
      this.socket.close(1000);
    }
  }

  private deliver(frame: TransportFrame): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve(frame);
    else this.inbox.push(frame);
  }

  private drainWithError(error: Error): void {
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }

  private drainWithNull(): void {
    for (const waiter of this.waiters.splice(0)) waiter.resolve(null);
  }
}

function desktopSocketUrl(connectionToken?: string): URL {
  const url = new URL("ws://localhost/");
  if (connectionToken) url.searchParams.set("tkn", connectionToken);
  return url;
}

function implementationInfo(result: InitializeResult): {
  name?: string;
  version?: string;
} {
  return {
    name: result.serverInfo?.name,
    version: result.serverInfo?.version,
  };
}

async function probeDesktopSocket(
  candidate: {
    socketPath: string;
    connectionToken?: string;
    modifiedAt: number;
  },
): Promise<DesktopSocketProbeOutcome> {
  let client: AhpClient | undefined;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONNECT_TIMEOUT_MS);
  try {
    return await awaitAbortable(async () => {
      const connection = await connectInitializedClient(async () => {
        const transport = await NodeWebSocketTransport.connect(
          desktopSocketUrl(candidate.connectionToken),
          controller.signal,
          candidate.socketPath,
        );
        const nextClient = new AhpClient(transport, { requestTimeoutMs: CONNECT_TIMEOUT_MS });
        nextClient.connect();
        client = nextClient;
        return nextClient;
      });
      client = connection.client;
      const initialized = connection.initialized;
      const sessions = await listAllSessions(client);
      const server = implementationInfo(initialized);
      return {
        probe: {
          ...candidate,
          sessionCount: sessions.length,
          protocolVersion: initialized.protocolVersion,
          serverName: server.name,
          serverVersion: server.version,
        },
      };
    }, controller.signal);
  } catch (error) {
    const incompatibility = readProtocolCompatibilityError(error);
    if (process.env.AHP_DEBUG) {
      console.debug(
        incompatibility
          ? "[ahp:endpoint] candidate has no tested protocol overlap"
          : "[ahp:endpoint] candidate rejected",
        candidate.socketPath,
        error instanceof Error ? error.message : error,
      );
    }
    return incompatibility ? { incompatibility } : {};
  } finally {
    clearTimeout(timer);
    if (client) {
      await awaitWithTimeout(
        () => client!.shutdown(), 1_000, "AHP probe cleanup timed out",
      ).catch((error) => console.warn("[ahp:endpoint] Probe cleanup failed:", error));
    }
  }
}

async function discoverDesktopSocket(): Promise<CachedDesktopSelection> {
  if (cachedDesktopSelection && cachedDesktopSelection.expiresAt > Date.now()) {
    return cachedDesktopSelection;
  }
  if (pendingDesktopSelection) return pendingDesktopSelection;
  pendingDesktopSelection = probeDesktopCandidates();
  try {
    return await pendingDesktopSelection;
  } finally {
    pendingDesktopSelection = undefined;
  }
}

async function probeDesktopCandidates(): Promise<CachedDesktopSelection> {
  const candidates = await discoverLocalEditorEndpoints();
  if (candidates.length === 0) {
    throw new TransportError(
      "io",
      "No live VS Code editor Agent Host endpoint was found",
    );
  }

  const results = await Promise.all(candidates.map(probeDesktopSocket));
  const probes = results.flatMap((result) => result.probe ? [result.probe] : []);
  const selected = selectDesktopSocket(probes);
  if (!selected) {
    const incompatibilities = results.flatMap(
      (result) => result.incompatibility ? [result.incompatibility] : [],
    );
    const candidateVersionSets = results.map(
      (result) => result.incompatibility?.hostSupportedVersions,
    );
    const incompatibleVersions = aggregateIncompatibleProtocolVersions(
      candidateVersionSets,
    );
    if (
      incompatibleVersions
      && allDesktopCandidatesProtocolIncompatible(candidateVersionSets)
    ) {
      throw new ProtocolCompatibilityError({
        failure: "no-overlap",
        hostSupportedVersions: incompatibleVersions,
        relation: incompatibilities.some((error) => error.relation === "unknown")
          ? "unknown"
          : undefined,
      });
    }
    throw new TransportError(
      "io",
      `Found ${candidates.length} VS Code editor Agent Host endpoint(s), but none accepted AHP ${OFFERED_PROTOCOL_VERSIONS.join(", ")}`,
    );
  }

  cachedDesktopSelection = {
    selected,
    candidateCount: candidates.length,
    compatibleCandidateCount: probes.length,
    expiresAt: Date.now() + DISCOVERY_TTL_MS,
  };
  return cachedDesktopSelection;
}

async function connectDesktop(signal?: AbortSignal): Promise<ConnectedAhpTransport> {
  let selection = await awaitAbortable(discoverDesktopSocket, signal);
  throwIfAborted(signal);
  let transport: AhpTransport;
  try {
    transport = await NodeWebSocketTransport.connect(
      desktopSocketUrl(selection.selected.connectionToken),
      signal,
      selection.selected.socketPath,
    );
  } catch (error) {
    if (signal?.aborted) throw error;
    cachedDesktopSelection = undefined;
    selection = await awaitAbortable(discoverDesktopSocket, signal);
    throwIfAborted(signal);
    transport = await NodeWebSocketTransport.connect(
      desktopSocketUrl(selection.selected.connectionToken),
      signal,
      selection.selected.socketPath,
    );
  }

  return {
    transport,
    diagnostics: {
      logicalUrl: LOCAL_DESKTOP_HOST,
      transport: process.platform === "win32"
        ? "named-pipe-websocket"
        : "unix-websocket",
      resolvedTarget: selection.selected.socketPath,
      candidateCount: selection.candidateCount,
      compatibleCandidateCount: selection.compatibleCandidateCount,
      selectedSessionCount: selection.selected.sessionCount,
      selectionReason: "largest compatible editor catalog, then newest endpoint",
    },
  };
}

function validateRemoteHost(hostUrl: string): URL {
  const parsed = new URL(hostUrl);
  if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
    throw new TransportError("io", "AHP host must be vscode-local://desktop, ws://, or wss://");
  }
  return parsed;
}

export async function connectAhpTransport(hostUrl: string, signal?: AbortSignal): Promise<ConnectedAhpTransport> {
  throwIfAborted(signal);
  if (hostUrl === LOCAL_DESKTOP_HOST) return connectDesktop(signal);

  const parsed = validateRemoteHost(hostUrl);
  return {
    transport: await NodeWebSocketTransport.connect(parsed, signal),
    diagnostics: {
      logicalUrl: hostUrl,
      transport: "websocket",
      resolvedTarget: parsed.toString(),
      candidateCount: 1,
      compatibleCandidateCount: 1,
    },
  };
}

export async function connectInitializedAhpClient(
  hostUrl: string,
  options: ConnectAhpClientOptions = {},
): Promise<ConnectedAhpClient> {
  const {
    signal,
    requestTimeoutMs,
    wrapTransport,
    ...initializeOptions
  } = options;
  let endpoint: ConnectedAhpTransport | undefined;
  let ownedClient: AhpClient | undefined;
  const onAbort = () => {
    void ownedClient?.shutdown().catch((error) => console.warn("[ahp:endpoint] Cancelled connection cleanup failed:", error));
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const connection = await awaitAbortable(() => connectInitializedClient(async () => {
      endpoint = await connectAhpTransport(hostUrl, signal);
      if (signal?.aborted) {
        await endpoint.transport.close();
        throwIfAborted(signal);
      }
      const transport = wrapTransport
        ? wrapTransport(endpoint.transport)
        : endpoint.transport;
      const client = new AhpClient(transport, { requestTimeoutMs });
      ownedClient = client;
      client.connect();
      return client;
    }, initializeOptions), signal);
    throwIfAborted(signal);

    if (!endpoint) {
      await connection.client.shutdown().catch(() => {});
      throw new TransportError("io", "AHP connection initialized without endpoint diagnostics");
    }

    return {
      ...connection,
      diagnostics: endpoint.diagnostics,
    };
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}

export function clearDesktopEndpointCache(): void {
  cachedDesktopSelection = undefined;
}
