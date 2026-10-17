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
import { AHPSessionSummary } from "@/lib/ahp/types";
import { getCachedSessions } from "@/lib/db/session-cache";
import { triageCard } from "@/lib/orchestrator/triage";
import { getPersistedCardPhase } from "@/lib/orchestrator/gate-engine";
import {
  getAuthoritativeCardRisk,
  getAuthoritativeRiskSnapshot,
} from "@/lib/orchestrator/risk-store";
import { startHeartbeat, stopHeartbeat, isHeartbeatRunning, type HeartbeatAction } from "@/lib/orchestrator/heartbeat";
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

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type CardStreamEvent =
  | { type: "init"; cards: KanbanCard[]; connection?: AhpEndpointDiagnostics & { protocolVersion: string; totalSessions: number; visibleSessions: number; filteredSessions: number } }
  | { type: "cardChanged"; card: KanbanCard; triage?: TriageEvent }
  | { type: "cardRemoved"; cardId: string }
  | { type: "heartbeat"; action: HeartbeatAction }
  | InboxStreamEvent
  | ConnectionError;

interface TriageEvent {
  riskLevel: RiskLevel;
  factors: string[];
  requiredGates: string[];
  requiresHumanApproval: boolean;
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
    return mapSessionToCard(session, undefined, undefined, undefined, workers);
  }
}

const TRIAGE_PHASES: Phase[] = ["plan", "build"];

async function tryTriage(
  hostUrl: string,
  card: KanbanCard,
  _session: AHPSessionSummary,
  _enrichment?: ChangesetEnrichment | null,
  automationScopes: Iterable<Set<string> | null> = [],
  phaseChanged = false,
): Promise<TriageEvent | undefined> {
  if (!isCardInAnyAutomationScope(card, automationScopes)) return undefined;
  if (!TRIAGE_PHASES.includes(card.phase)) return undefined;

  // Only triage when the agent is done or waiting on input — not while running
  if (card.runtime === "running") return undefined;

  // Triage when the card's inferred phase differs from what's persisted in DB.
  if (!phaseChanged) {
    const risk = getAuthoritativeCardRisk(card.id, hostUrl);
    // Initial triage is automatic. A stale/legacy assessment must be explicitly
    // reassessed instead of creating an event-driven reassessment loop.
    if (risk.status !== "missing") return undefined;
  }

  try {
    const snapshot = getAuthoritativeRiskSnapshot(hostUrl, card.id);
    if (!snapshot) return undefined;
    const result = await triageCard(
      card.id,
      snapshot,
      card.phase
    );

    if (!result) return undefined;

    // Update the card's risk from the triage
    card.risk = result.risk.level;
    if (result.requiresHumanApproval) {
      card.attention = "needs-human";
    }

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

async function projectRemoteEvent(
  hostUrl: string,
  event: Exclude<BridgeEvent, ConnectionError>,
  automationScopes: Iterable<Set<string> | null>,
): Promise<CardStreamEvent> {
  if (event.type === "init") {
    const cards = event.sessions.map((s) => {
      const card = safeEnrich(s, event.enrichments.get(s.resource), undefined, event.workers.get(s.resource));
      const pi = event.pendingInputs.get(s.resource);
      if (pi) card.pendingInput = pi;
      return card;
    });
    return { type: "init", cards, connection: event.connection };
  }

  if (event.type === "sessionRemoved") {
    return {
      type: "cardRemoved",
      cardId: event.resource,
    };
  }

  const previousPhase = getPersistedCardPhase(event.session.resource);
  let card = safeEnrich(event.session, event.enrichment, undefined, event.workers);
  // Attach pending input if available (null means explicitly cleared)
  if (event.pendingInput !== undefined) {
    card.pendingInput = event.pendingInput ?? undefined;
  }
  const triage = await tryTriage(
    hostUrl,
    card,
    event.session,
    event.enrichment,
    automationScopes,
    previousPhase !== card.phase,
  );
  if (triage) {
    const pendingInput = card.pendingInput;
    card = safeEnrich(event.session, event.enrichment, undefined, event.workers);
    if (pendingInput) card.pendingInput = pendingInput;
  }

  return {
    type: "cardChanged",
    card,
    triage,
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
      const initEvent = `data: ${JSON.stringify({ type: "init", cards: [] } satisfies CardStreamEvent)}\n\n`;
      controller.enqueue(encoder.encode(initEvent));
    },
  });
}

let nextStreamId = 0;

interface HostConnectionResource {
  abortController: AbortController;
  bridgeStarted: boolean;
  connected: boolean;
  streamWrites: Promise<void>;
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
    streamWrites: Promise.resolve(),
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
        isCardInAnyAutomationScope(card, scopes)
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

  const cached = getCachedSessions(hostUrl).find(
    (entry) => entry.sessionUri === cardId,
  );
  if (!cached) return undefined;

  const refreshed = safeEnrich(
    cached.summary,
    cached.enrichment,
    { recordStatus: false },
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
    partition.cards = partition.cards.filter(
      (card) => card.id !== projected.cardId,
    );
  }
}

function terminateHost(partition: HostPartition, error: ConnectionError): void {
  if (!hostStreams.isCurrent(partition)) return;
  partition.resource.connected = false;
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
      partition.resource.streamWrites = partition.resource.streamWrites
        .then(async () => {
          if (hostStreams.get(partition.hostUrl) !== partition) return;
          const scopes = Array.from(
            partition.subscribers.values(),
            (subscriber) => subscriber.workspaceScope,
          );
          const projected = await projectRemoteEvent(
            partition.hostUrl,
            event,
            scopes,
          );
          if (!hostStreams.isCurrent(partition)) return;
          try {
            if (
              event.type === "sessionRemoved" &&
              event.reason === "archived" &&
              event.session
            ) {
              projectArchivedSessionToInbox(partition.hostUrl, event.session);
            } else if (event.type === "sessionRemoved") {
              projectRemovedSessionToInbox(partition.hostUrl, event.resource);
            } else if (projected.type === "init") {
              for (const card of projected.cards) {
                projectCardToInbox(partition.hostUrl, card);
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
        })
        .catch((error) => {
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
  workspaceScope: Set<string> | null
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const streamId = nextStreamId++;
  let closed = false;
  let unsubscribeInbox: (() => void) | undefined;

  function closeStream(): void {
    if (closed) return;
    closed = true;
    unsubscribeInbox?.();
    const { activeHostCount } = hostStreams.unsubscribe(hostUrl, streamId);
    if (activeHostCount === 0) void stopHeartbeat();
  }

  return new ReadableStream<Uint8Array>({
    start(controller) {
      const subscriber = {
        id: streamId,
        workspaceScope,
        send(event: CardStreamEvent) {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
          );
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
      unsubscribeInbox = inboxEvents.subscribe((event) => {
        if (inboxEventMatchesHost(event, hostUrl)) {
          subscriber.send(event);
        }
      });

      if (firstForHost) {
        try {
          partition.cards = getCachedSessions(hostUrl).map((cached) =>
            safeEnrich(cached.summary, cached.enrichment, {
              recordStatus: false,
            })
          );
        } catch {
          partition.cards = [];
        }
        partition.initialized = true;
      }
      hostStreams.replayInitialization(
        partition,
        subscriber,
        (cards) => ({ type: "init", cards }),
      );

      ensureHeartbeat();
      startHostBridge(partition);
    },
    cancel() {
      closeStream();
    },
  });
}

export async function GET(request: NextRequest) {
  const requestError = validateLocalEventStreamRequest(request);
  if (requestError) {
    return NextResponse.json({ error: requestError }, { status: 403 });
  }

  const hostUrl = request.nextUrl.searchParams.get("host");
  console.info("[ahp:sse]", hostUrl ? `remote stream → ${hostUrl}` : "no host (empty board)");
  const workspaceScope = parseWorkspaceScope(request.nextUrl.searchParams.get("workspaceScope"));
  const stream = hostUrl ? createRemoteStream(hostUrl, workspaceScope) : createEmptyStream();

  return new NextResponse(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
