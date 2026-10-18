import { NextRequest, NextResponse } from "next/server";

import { createAHPBridge, BridgeEvent } from "@/lib/ahp/client-bridge";
import type { AhpEndpointDiagnostics } from "@/lib/ahp/endpoint";
import { enrichSessionToCard, type EnrichOptions } from "@/lib/ahp/enrich-card";
import { mapSessionToCard } from "@/lib/ahp/map-session";
import type { ChangesetEnrichment } from "@/lib/ahp/changeset-enricher";
import {
  classifyError,
  type ConnectionError,
} from "@/lib/ahp/connection-error";
import {
  HostStreamRegistry,
  type HostStreamPartition,
} from "@/lib/ahp/host-stream-registry";
import { AHPSessionSummary, AHPStatus, shouldShowSession } from "@/lib/ahp/types";
import { getCachedSession, getCachedSessions } from "@/lib/db/session-cache";
import { triageCard } from "@/lib/orchestrator/triage";
import {
  getAuthoritativeCardRisk,
  getAuthoritativeRiskSnapshot,
} from "@/lib/orchestrator/risk-store";
import { startHeartbeat, stopHeartbeat, isHeartbeatRunning, requestHeartbeatTick, invalidateHostWork, type HeartbeatAction } from "@/lib/orchestrator/heartbeat";
import { isCardInAnyAutomationScope, parseWorkspaceScope } from "@/lib/automation-scope";
import { validateLocalEventStreamRequest } from "@/lib/http/local-mutation";
import {
  projectArchivedSessionToInbox,
  projectCardToInbox,
  projectHeartbeatToInbox,
  projectRemovedSessionToInbox,
} from "@/lib/inbox/service";
import { inboxEventMatchesHost, inboxEvents } from "@/lib/inbox/events";
import type { InboxStreamEvent } from "@/lib/inbox/types";
import { KanbanCard, type Phase, type RiskLevel } from "@/lib/types";
import { registerDesktopHosts } from "@/lib/desktop/status";
import { isWorkspaceEnabled } from "@/lib/orchestrator/config-file";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type CardStreamEvent =
  | { type: "init"; cards: KanbanCard[]; cached?: boolean; connection?: AhpEndpointDiagnostics & { protocolVersion: string; totalSessions: number; visibleSessions: number; filteredSessions: number } }
  | { type: "cardChanged"; card: KanbanCard; triage?: TriageEvent; pendingInputCleared?: boolean }
  | { type: "cardRemoved"; cardId: string; archivedSession?: ArchivedSession }
  | { type: "heartbeat"; action: HeartbeatAction }
  | InboxStreamEvent
  | ConnectionError;

interface TriageEvent {
  riskLevel: RiskLevel;
  factors: string[];
  requiredGates: string[];
  requiresHumanApproval: boolean;
}

interface ArchivedSession {
  session: AHPSessionSummary;
  enrichment?: ChangesetEnrichment | null;
  workers?: KanbanCard["workers"];
  card?: KanbanCard;
}

function archiveCard(entry: ArchivedSession, hostUrl: string): KanbanCard {
  return entry.card ??= safeEnrich(entry.session, entry.enrichment, {
    hostUrl,
    recordStatus: false,
  }, entry.workers);
}

function safeEnrich(
  session: AHPSessionSummary,
  changesetData?: ChangesetEnrichment | null,
  options?: EnrichOptions,
  workers?: KanbanCard["workers"],
): KanbanCard {
  try {
    return enrichSessionToCard(session, changesetData, options, workers);
  } catch (err) {
    console.warn("[ahp:sse] enrichment failed, using base mapping:", err instanceof Error ? err.message : err);
    return {
      ...mapSessionToCard(session, undefined, undefined, undefined, workers),
      phase: "define",
      gateStatus: "pending",
      attention: "stale",
      gateBlocker: "Card facts are unavailable. Automation is disabled.",
    };
  }
}

const TRIAGE_PHASES: Phase[] = ["plan", "build"];

async function tryTriage(
  hostUrl: string,
  card: KanbanCard,
  automationScopes: Iterable<Set<string> | null> = [],
  isCurrent: () => boolean = () => true,
): Promise<TriageEvent | undefined> {
  if (!isWorkspaceEnabled(card)) return undefined;
  if (card.isArchived) return undefined;
  if (!isCardInAnyAutomationScope(card, automationScopes)) return undefined;
  if (!TRIAGE_PHASES.includes(card.phase)) return undefined;

  // Only triage when the agent is done or waiting on input — not while running
  if (card.runtime === "running") return undefined;

  // Missing/stale facts share the bounded assessment lane with heartbeat.
  // scheduleTriage fences repeated attempts by digest and cooldown.
  const risk = getAuthoritativeCardRisk(card.id, hostUrl);
  if (risk.status === "current") return undefined;

  try {
    const snapshot = getAuthoritativeRiskSnapshot(hostUrl, card.id);
    if (!snapshot) return undefined;
    const result = await triageCard(
      card.id,
      snapshot,
      card.phase,
      { isCurrent, projectPath: card.workingDirectory },
    );

    if (!result) return undefined;

    return {
      riskLevel: result.risk.level,
      factors: result.risk.factors,
      requiredGates: result.requiredGates.map(
        (g) => g.gateName ?? g.gateType
      ),
      requiresHumanApproval: result.requiresHumanApproval,
    };
  } catch (err) {
    console.warn("[ahp:sse] triage failed:", err instanceof Error ? err.message : err);
    return undefined;
  }
}

function projectRemoteEvent(
  event: Exclude<BridgeEvent, ConnectionError>,
  hostUrl: string,
  archives: Map<string, ArchivedSession>,
): CardStreamEvent {
  if (event.type === "init") {
    const startedAt = performance.now();
    archives.clear();
    const cards = event.sessions.filter(isWorkspaceEnabled).filter((session) => {
      if (!(session.status & AHPStatus.IsArchived)) return true;
      archives.set(session.resource, {
        session,
        enrichment: event.enrichments.get(session.resource),
        workers: event.workers.get(session.resource),
      });
      return false;
    }).map((s) => {
      const card = safeEnrich(s, event.enrichments.get(s.resource), { hostUrl }, event.workers.get(s.resource));
      const pi = event.pendingInputs.get(s.resource);
      if (pi) card.pendingInput = pi;
      return card;
    });
    if (process.env.PLANWERK_DESKTOP_TOKEN) console.info("[performance]", JSON.stringify({
      metric: "server.project-init", durationMs: performance.now() - startedAt, cards: cards.length,
    }));
    return {
      type: "init", cards,
      connection: {
        ...event.connection,
        visibleSessions: cards.length + archives.size,
        filteredSessions: event.connection.totalSessions - cards.length - archives.size,
      },
    };
  }

  if (event.type === "sessionRemoved") {
    archives.delete(event.resource);
    return {
      type: "cardRemoved",
      cardId: event.resource,
    };
  }

  if (!isWorkspaceEnabled(event.session)) {
    archives.delete(event.session.resource);
    return { type: "cardRemoved", cardId: event.session.resource };
  }
  if (event.session.status & AHPStatus.IsArchived) {
    const archivedSession: ArchivedSession = {
      session: event.session, enrichment: event.enrichment, workers: event.workers,
    };
    archives.set(event.session.resource, archivedSession);
    return { type: "cardRemoved", cardId: event.session.resource, archivedSession };
  }
  archives.delete(event.session.resource);
  const card = safeEnrich(event.session, event.enrichment, { hostUrl }, event.workers);
  // Attach pending input if available (null means explicitly cleared)
  if (event.pendingInput !== undefined) {
    card.pendingInput = event.pendingInput ?? undefined;
  }
  return {
    type: "cardChanged",
    card,
    pendingInputCleared: event.pendingInput === null,
  };
}

/**
 * Safety net: when the SSE endpoint is hit without a host param (e.g., during
 * rehydration edge cases), emit an empty board so the client has a valid init.
 */
function createEmptyStream(): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const initEvent = `data: ${JSON.stringify({ type: "init", cards: [], epoch: crypto.randomUUID(), sequence: 1 })}\n\n`;
      controller.enqueue(encoder.encode(initEvent));
    },
  });
}

let nextStreamId = 0;

interface HostConnectionResource {
  abortController: AbortController;
  bridgeStarted: boolean;
  connected: boolean;
  triagePending: Set<string>;
  triageAttempts: Map<string, { digest: string; at: number }>;
  archives: Map<string, ArchivedSession>;
}

type HostPartition = HostStreamPartition<
  KanbanCard,
  CardStreamEvent,
  HostConnectionResource
>;

const hostStreams = new HostStreamRegistry<
  KanbanCard,
  CardStreamEvent,
  HostConnectionResource
>(
  () => ({
    abortController: new AbortController(),
    bridgeStarted: false,
    connected: false,
    triagePending: new Set(),
    triageAttempts: new Map(),
    archives: new Map(),
  }),
  (resource) => resource.abortController.abort(),
);

registerDesktopHosts(() => Array.from(hostStreams.entries(), ([hostUrl, partition]) => ({
  hostUrl,
  connected: partition.resource.connected,
  running: partition.cards.filter((card) => card.runtime === "running").length,
})));

function getAutomationHosts() {
  return Array.from(hostStreams.entries())
    .filter(([, partition]) => partition.resource.connected)
    .map(([hostUrl, partition]) => {
    const scopes = Array.from(
      partition.subscribers.values(),
      (subscriber) => subscriber.workspaceScope,
    );
    return {
      hostUrl,
      cards: partition.cards.filter((card) =>
        isWorkspaceEnabled(card) && isCardInAnyAutomationScope(card, scopes)
      ),
    };
  });
}

function reprojectCard(
  hostUrl: string,
  cardId: string,
): { previous: KanbanCard; refreshed: KanbanCard } | undefined {
  const partition = hostStreams.get(hostUrl);
  const existing = partition?.cards.find((card) => card.id === cardId);
  if (!partition || !existing) return undefined;
  if (!isWorkspaceEnabled(existing)) return undefined;

  const cached = getCachedSession(hostUrl, cardId);
  if (!cached) return undefined;

  const refreshed = safeEnrich(
    cached.summary,
    cached.enrichment,
    { recordStatus: false, hostUrl },
    existing.workers,
  );
  if (existing.pendingInput && refreshed.runtime === "input-needed") {
    refreshed.pendingInput = existing.pendingInput;
  }
  partition.cards = [
    ...partition.cards.filter((card) => card.id !== cardId),
    refreshed,
  ];
  return { previous: existing, refreshed };
}

function reportInboxProjectionError(
  source: string,
  error: unknown,
): void {
  console.error(
    `[inbox:projector] ${source} failed:`,
    error instanceof Error ? error.message : error,
  );
}

function deliverHeartbeatAction(
  hostUrl: string,
  action: HeartbeatAction,
): void {
  hostStreams.broadcast(hostUrl, { type: "heartbeat", action });

  const reprojection = "cardId" in action
    ? reprojectCard(hostUrl, action.cardId)
    : undefined;
  try {
    if (
      action.type === "phase-advanced" &&
      (action.to === "review" || action.to === "ship") &&
      reprojection
    ) {
      projectCardToInbox(
        hostUrl,
        reprojection.refreshed,
        reprojection.previous,
      );
    } else {
      projectHeartbeatToInbox(hostUrl, action, reprojection?.refreshed);
      if (reprojection) {
        projectCardToInbox(
          hostUrl,
          reprojection.refreshed,
          reprojection.previous,
        );
      }
    }
  } catch (error) {
    reportInboxProjectionError(`heartbeat ${action.type}`, error);
  }

  if (reprojection) {
    hostStreams.broadcast(hostUrl, {
      type: "cardChanged",
      card: reprojection.refreshed,
    });
  }
}

function ensureHeartbeat(): void {
  if (!isHeartbeatRunning()) {
    startHeartbeat(getAutomationHosts, deliverHeartbeatAction);
  }
}

function scheduleTriage(partition: HostPartition, card: KanbanCard): void {
    if (card.runtime === "running" || !TRIAGE_PHASES.includes(card.phase)) return;
    if (getAuthoritativeCardRisk(card.id, partition.hostUrl).status === "current") return;
    if (partition.resource.triagePending.has(card.id)) return;
    const snapshot = getAuthoritativeRiskSnapshot(partition.hostUrl, card.id);
    if (!snapshot) return;
    const attempt = partition.resource.triageAttempts.get(card.id);
    if (attempt?.digest === snapshot.digest && Date.now() - attempt.at < 60_000) return;
    partition.resource.triageAttempts.set(card.id, { digest: snapshot.digest, at: Date.now() });
    partition.resource.triagePending.add(card.id);
    const phase = card.phase;
    void Promise.resolve().then(async () => {
      if (!hostStreams.isCurrent(partition)) return;
      const scopes = Array.from(partition.subscribers.values(), (subscriber) => subscriber.workspaceScope);
      const isCurrent = () => hostStreams.isCurrent(partition)
        && isWorkspaceEnabled(card)
        && getAuthoritativeRiskSnapshot(partition.hostUrl, card.id)?.digest === snapshot.digest
        && partition.cards.some((item) => item.id === card.id && item.phase === phase
          && isCardInAnyAutomationScope(item, Array.from(partition.subscribers.values(), (subscriber) => subscriber.workspaceScope)));
      const triage = await tryTriage(partition.hostUrl, card, scopes, isCurrent);
      if (!triage || !hostStreams.isCurrent(partition)) return;
      const current = getAuthoritativeRiskSnapshot(partition.hostUrl, card.id);
      const existing = partition.cards.find((item) => item.id === card.id);
      if (current?.digest !== snapshot.digest || existing?.phase !== phase) return;
      const reprojection = reprojectCard(partition.hostUrl, card.id);
      if (reprojection) {
        hostStreams.broadcastPartition(partition, { type: "cardChanged", card: reprojection.refreshed, triage });
        requestHeartbeatTick(partition.hostUrl, card.id);
      }
    }).catch((error) => {
      console.warn("[ahp:sse] Background triage failed:", error);
    }).finally(() => {
      partition.resource.triagePending.delete(card.id);
    });
}

function applyProjectedEvent(
  partition: HostPartition,
  projected: CardStreamEvent,
): void {
  if (projected.type === "init") {
    partition.resource.connected = true;
    partition.cards = projected.cards;
    partition.initialized = true;
    return;
  }
  if (projected.type === "error") {
    partition.resource.connected = false;
  }
  if (projected.type === "cardChanged") {
    const incoming = projected.card;
    const existing = partition.cards.find((card) => card.id === incoming.id);
    if (
      existing?.pendingInput &&
      !incoming.pendingInput &&
      !projected.pendingInputCleared &&
      incoming.runtime === "input-needed"
    ) {
      incoming.pendingInput = existing.pendingInput;
    }
    partition.cards = [
      ...partition.cards.filter((card) => card.id !== incoming.id),
      incoming,
    ];
    return;
  }
  if (projected.type === "cardRemoved") {
    partition.resource.triageAttempts.delete(projected.cardId);
    partition.cards = partition.cards.filter(
      (card) => card.id !== projected.cardId,
    );
  }
}

function terminateHost(partition: HostPartition, error: ConnectionError): void {
  if (!hostStreams.isCurrent(partition)) return;
  partition.resource.connected = false;
  invalidateHostWork(partition.hostUrl);
  hostStreams.broadcastPartition(partition, error);
  hostStreams.closeHost(partition.hostUrl, partition);
  if (hostStreams.size === 0) void stopHeartbeat();
}

function startHostBridge(partition: HostPartition): void {
  if (partition.resource.bridgeStarted) return;
  partition.resource.bridgeStarted = true;

  void createAHPBridge({
    hostUrl: partition.hostUrl,
    signal: partition.resource.abortController.signal,
    onEvent(incoming: BridgeEvent) {
      if (!hostStreams.isCurrent(partition)) return;
      if (incoming.type === "error") {
        terminateHost(partition, incoming);
        return;
      }
      // Bridge payloads are plain data; capture their state before queueing.
      const event = structuredClone(incoming);
      try {
          if (hostStreams.get(partition.hostUrl) !== partition) return;
          const projected = projectRemoteEvent(
            event,
            partition.hostUrl,
            partition.resource.archives,
          );
          if (!hostStreams.isCurrent(partition)) return;
          const removedActiveCard = projected.type === "cardRemoved"
            && partition.cards.some((card) => card.id === projected.cardId);
          try {
            if (
              event.type === "sessionRemoved" &&
              event.reason === "archived" &&
              event.session &&
              isWorkspaceEnabled(event.session)
            ) {
              projectArchivedSessionToInbox(partition.hostUrl, event.session);
            } else if (event.type === "sessionRemoved") {
              projectRemovedSessionToInbox(partition.hostUrl, event.resource);
            } else if (projected.type === "init") {
              for (const card of projected.cards) {
                projectCardToInbox(partition.hostUrl, card);
              }
            } else if (projected.type === "cardRemoved" && projected.archivedSession) {
              if (removedActiveCard) {
                projectArchivedSessionToInbox(partition.hostUrl, projected.archivedSession.session);
              }
            } else if (projected.type === "cardChanged") {
              const previousCard = partition.cards.find(
                (card) => card.id === projected.card.id,
              );
              projectCardToInbox(
                partition.hostUrl,
                projected.card,
                previousCard,
              );
            }
          } catch (error) {
            reportInboxProjectionError(event.type, error);
          }
          if (
            !hostStreams.applyIfCurrent(
              partition,
              (current) => applyProjectedEvent(current, projected),
            )
          ) {
            return;
          }
          hostStreams.broadcastPartition(partition, projected);
          if (projected.type === "init") requestHeartbeatTick(partition.hostUrl);
          if (projected.type === "cardChanged") requestHeartbeatTick(partition.hostUrl, projected.card.id);
          if (projected.type === "cardRemoved" && removedActiveCard) requestHeartbeatTick(partition.hostUrl, projected.cardId);
          if (projected.type === "cardChanged") scheduleTriage(partition, projected.card);
      } catch (error) {
          if (
            partition.resource.abortController.signal.aborted ||
            !hostStreams.isCurrent(partition)
          ) {
            return;
          }
          terminateHost(
            partition,
            classifyError(error instanceof Error ? error.message : "Connection failed", "stream"),
          );
      }
    },
  }).catch((error) => {
    if (
      partition.resource.abortController.signal.aborted ||
      !hostStreams.isCurrent(partition)
    ) {
      return;
    }
    terminateHost(
      partition,
      classifyError(error instanceof Error ? error.message : "Connection failed", "stream"),
    );
  });
}

function createRemoteStream(
  hostUrl: string,
  workspaceScope: Set<string> | null,
  archivedOnly: boolean,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const streamId = nextStreamId++;
  let closed = false;
  let unsubscribeInbox: (() => void) | undefined;
  const epoch = crypto.randomUUID();
  let sequence = 0;
  const maxBufferedBytes = 8 * 1024 * 1024;

  function closeStream(): void {
    if (closed) return;
    closed = true;
    unsubscribeInbox?.();
    const partition = hostStreams.get(hostUrl);
    if (partition?.subscribers.size === 1 && partition.subscribers.has(streamId)) invalidateHostWork(hostUrl);
    const { activeHostCount } = hostStreams.unsubscribe(hostUrl, streamId);
    if (activeHostCount === 0) void stopHeartbeat();
  }

  return new ReadableStream<Uint8Array>({
    start(controller) {
      const subscriber = {
        id: streamId,
        workspaceScope: archivedOnly ? null : workspaceScope,
        send(event: CardStreamEvent) {
          if (closed) return;
          const archives = hostStreams.get(hostUrl)?.resource.archives;
          let outgoing: CardStreamEvent = event;
          if (archivedOnly) {
            if (event.type === "init") {
              outgoing = {
                ...event,
                cards: Array.from(archives?.values() ?? [], (entry) => archiveCard(entry, hostUrl)),
              };
            } else if (event.type === "cardRemoved" && event.archivedSession) {
              outgoing = { type: "cardChanged", card: archiveCard(event.archivedSession, hostUrl) };
            } else if (event.type === "cardChanged") {
              outgoing = { type: "cardRemoved", cardId: event.card.id };
            } else if (event.type !== "cardRemoved" && event.type !== "error") {
              return;
            }
          } else if (event.type === "cardRemoved") {
            outgoing = { type: "cardRemoved", cardId: event.cardId };
          }
          const startedAt = performance.now();
          const frame = encoder.encode(`data: ${JSON.stringify({ ...outgoing, archivedCount: archives?.size ?? 0, epoch, sequence: ++sequence })}\n\n`);
          if (frame.byteLength > maxBufferedBytes) {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({
              type: "error", code: "unknown",
              message: "Board snapshot exceeds the event-stream byte limit",
              hint: "Reduce the visible board before reconnecting.",
              epoch, sequence,
            })}\n\n`));
            closeStream();
            controller.close();
            return;
          }
          if ((controller.desiredSize ?? 0) < frame.byteLength) {
            closeStream();
            controller.error(new Error("Event stream buffer exceeded; reconnect for a current snapshot"));
            return;
          }
          controller.enqueue(frame);
          if (event.type === "init" && process.env.PLANWERK_DESKTOP_TOKEN) console.info("[performance]", JSON.stringify({
            metric: "server.sse-init", durationMs: performance.now() - startedAt,
            cards: event.cards.length, cached: Boolean(event.cached), bytes: frame.byteLength,
          }));
        },
        close() {
          closeStream();
          controller.close();
        },
      };
      const { partition, firstForHost } = hostStreams.subscribe(
        hostUrl,
        subscriber,
      );
      if (!archivedOnly) {
        unsubscribeInbox = inboxEvents.subscribe((event) => {
          if (inboxEventMatchesHost(event, hostUrl)) {
            subscriber.send(event);
          }
        });
      }

      if (firstForHost) {
        const startedAt = performance.now();
        try {
          partition.cards = getCachedSessions(hostUrl)
            .filter((cached) => shouldShowSession(cached.summary.status, cached.summary.changes?.files)
              && isWorkspaceEnabled(cached.summary))
            .filter((cached) => {
              if (!(cached.summary.status & AHPStatus.IsArchived)) return true;
              partition.resource.archives.set(cached.summary.resource, {
                session: cached.summary, enrichment: cached.enrichment,
              });
              return false;
            }).map((cached) =>
            safeEnrich(cached.summary, cached.enrichment, {
              recordStatus: false,
              hostUrl,
            })
          );
        } catch (error) {
          console.warn("[ahp:sse] Cached initialization failed:", error);
          partition.cards = [];
        } finally {
          if (process.env.PLANWERK_DESKTOP_TOKEN) console.info("[performance]", JSON.stringify({
            metric: "server.cache-init", durationMs: performance.now() - startedAt, cards: partition.cards.length,
          }));
        }
        partition.initialized = true;
      }
      hostStreams.replayInitialization(
        partition,
        subscriber,
        (cards) => ({ type: "init", cards, cached: !partition.resource.connected }),
      );

      ensureHeartbeat();
      startHostBridge(partition);
    },
    cancel() {
      closeStream();
    },
  }, { highWaterMark: maxBufferedBytes, size: (frame) => frame.byteLength });
}

export async function GET(request: NextRequest) {
  const requestError = validateLocalEventStreamRequest(request);
  if (requestError) {
    return NextResponse.json({ error: requestError }, { status: 403 });
  }

  const hostUrl = request.nextUrl.searchParams.get("host");
  console.info("[ahp:sse]", hostUrl ? `remote stream → ${hostUrl}` : "no host (empty board)");
  const workspaceScope = parseWorkspaceScope(request.nextUrl.searchParams.get("workspaceScope"));
  const archivedOnly = request.nextUrl.searchParams.get("view") === "archived";
  const stream = hostUrl ? createRemoteStream(hostUrl, workspaceScope, archivedOnly) : createEmptyStream();

  return new NextResponse(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
