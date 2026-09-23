"use client";

import { useEffect, useRef } from "react";

import { useBoardStore } from "@/lib/store/board-store";
import { useConnectionStore } from "@/lib/store/connection-store";
import { useInboxStore } from "@/lib/store/inbox-store";
import { useOrchestratorStore } from "@/lib/store/orchestrator-store";
import type { GateStatus, KanbanCard, Phase } from "@/lib/types";

/** Fetch persisted phase + gate status for the given cards and reconcile any
 *  that differ from their AHP-derived state, so the board agrees with stored
 *  truth on load. */
async function hydratePersistedPhases(
  cards: KanbanCard[],
  reconcileCard: (id: string, patch: Partial<KanbanCard>) => void
): Promise<void> {
  if (cards.length === 0) return;
  try {
    const states: Record<
      string,
      { phase: Phase; gateStatus: GateStatus }
    > = {};
    const batchSize = 40;
    const requests: Promise<Response>[] = [];
    for (let index = 0; index < cards.length; index += batchSize) {
      const ids = cards
        .slice(index, index + batchSize)
        .map((card) => card.id)
        .join(",");
      requests.push(
        fetch(`/api/gates/phases?cardIds=${encodeURIComponent(ids)}`),
      );
    }
    for (const res of await Promise.all(requests)) {
      if (!res.ok) {
        console.warn(
          `[gates:hydrate] phase request failed with ${res.status}`,
        );
        continue;
      }
      const batch = (await res.json()) as {
        states: Record<string, { phase: Phase; gateStatus: GateStatus }>;
      };
      Object.assign(states, batch.states);
    }
    for (const card of cards) {
      const persisted = states[card.id];
      if (persisted && persisted.phase !== card.phase) {
        // Reconcile phase and its derived gate status together so a hydrated
        // phase never shows a gate status from the old (AHP-derived) phase.
        reconcileCard(card.id, {
          phase: persisted.phase,
          gateStatus: persisted.gateStatus,
        });
      }
    }
  } catch (error) {
    console.warn(
      "[gates:hydrate] phase hydration failed:",
      error instanceof Error ? error.message : error,
    );
  }
}

export function useLiveSessions() {
  const status = useConnectionStore((s) => s.status);
  const hostUrl = useConnectionStore((s) => s.hostUrl);
  const workspaceFilters = useBoardStore((s) => s.workspaceFilters);
  const setConnected = useConnectionStore((s) => s.setConnected);
  const setError = useConnectionStore((s) => s.setError);
  const eventSourceRef = useRef<EventSource | null>(null);
  // Tracks whether *this* stream has completed its initial handshake, updated
  // in real time (not tied to re-renders) so `es.onerror` can tell an initial
  // connection failure apart from a mid-stream drop without depending on the
  // `status` transition below.
  const hasHandshakedRef = useRef(false);

  const setCards = useBoardStore((s) => s.setCards);
  const replaceCard = useBoardStore((s) => s.replaceCard);
  const reconcileCard = useBoardStore((s) => s.reconcileCard);
  const addCard = useBoardStore((s) => s.addCard);
  const removeCard = useBoardStore((s) => s.removeCard);
  const addFeedItem = useOrchestratorStore((s) => s.addFeedItem);
  const setMonitoringStatus = useOrchestratorStore((s) => s.setMonitoringStatus);

  // Both "connected" and "reconnecting" mean "should have a stream open".
  // Using this boolean (rather than raw `status`) as the effect dependency
  // means the reconnecting→connected transition — which `setConnected()`
  // triggers on every `init` message — doesn't tear down and reopen the
  // EventSource right after the handshake. Root-channel notifications are
  // ephemeral and not replayed, so that reopen was dropping anything the host
  // emitted in the gap.
  const shouldConnect = status === "connected" || status === "reconnecting";
  const workspaceScope = JSON.stringify(Array.from(workspaceFilters).sort());

  useEffect(() => {
    if (!shouldConnect) {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
      return;
    }

    hasHandshakedRef.current = false;

    // Build the SSE URL — pass host when available
    let sseUrl = "/api/ahp/events";
    if (hostUrl) {
      sseUrl += `?host=${encodeURIComponent(hostUrl)}`;
      sseUrl += `&workspaceScope=${encodeURIComponent(workspaceScope)}`;
    }

    console.info("[ahp:sse]", `opening stream →`, sseUrl);
    const es = new EventSource(sseUrl);
    eventSourceRef.current = es;

    es.onopen = () => {
      console.info("[ahp:sse]", "stream open");
    };

    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);

        if (data.type === "error") {
          // Server-side connection error (e.g., AHP host unreachable)
          console.error("[ahp:sse]", "server error:", data.message);
          setError({
            message: data.message || "Connection error",
            code: data.code || "unknown",
            hint: data.hint,
          });
          es.close();
          eventSourceRef.current = null;
          return;
        }

        if (data.type === "init") {
          console.info("[ahp:sse]", `init: ${data.cards.length} cards`);
          setCards(data.cards);
          hasHandshakedRef.current = true;
          setConnected(data.connection);
          // Hydrate persisted phases from SQLite so a reload shows the stored
          // truth (not an AHP-derived default) and matches the gate engine.
          void hydratePersistedPhases(data.cards, reconcileCard);
          // Connection/monitoring status goes to the pinned status line, not the
          // conversational feed — system state is an instrument, not dialogue.
          setMonitoringStatus(data.cards.length);
        } else if (data.type === "cardChanged") {
          const card = data.card;
          const existing = useBoardStore.getState().getCard(card.id);
          if (existing) {
            replaceCard(card.id, card);
            if (
              card.activity
              && card.attention === "needs-human"
              && existing.attention !== "needs-human"
            ) {
              addFeedItem({
                type: "alert",
                message: card.activity,
                cardId: card.id,
                cardTitle: card.title,
                projectName: card.project?.name,
              });
            }
            // Surface triage results when a card enters plan/build
            if (data.triage) {
              const t = data.triage;
              const riskLabel = t.riskLevel.toUpperCase();
              const factorList = t.factors.length > 0 ? ` — ${t.factors.join(", ")}` : "";
              const gateList = t.requiredGates.length > 0 ? ` Gates: ${t.requiredGates.join(", ")}.` : "";
              const approval = t.requiresHumanApproval ? " ⚠️ Human approval required." : "";
              addFeedItem({
                type: "triage",
                message: `${riskLabel} risk${factorList}.${gateList}${approval}`,
                cardId: card.id,
                cardTitle: card.title,
                projectName: card.project?.name,
              });
            }
          } else {
            addCard(card);
          }
        } else if (data.type === "cardRemoved") {
          removeCard(data.cardId);
        } else if (data.type === "inboxAdded" || data.type === "inboxChanged") {
          if (data.item) {
            useInboxStore.getState().reconcileItem(data.item);
          }
        } else if (data.type === "inboxRemoved") {
          if (data.itemId !== undefined) {
            useInboxStore.getState().removeItem(String(data.itemId));
          }
        } else if (data.type === "heartbeat") {
          // Heartbeat action from the autonomous loop
          const action = data.action;
          if (action) {
            const feedMsg = formatHeartbeatAction(action);
            if (feedMsg) {
              const actionCard = useBoardStore.getState().getCard(action.cardId);
              addFeedItem({
                type: feedMsg.type,
                message: feedMsg.message,
                cardId: action.cardId,
                cardTitle: actionCard?.title,
                projectName: actionCard?.project?.name,
              });
            }
          }
        }
      } catch (e) {
        console.error("Failed to parse SSE event:", e);
      }
    };

    es.onerror = () => {
      if (!hasHandshakedRef.current) {
        // The server sends AHP failures as structured SSE events. Reaching
        // EventSource.onerror before init means the HTTP event stream failed.
        console.error("[ahp:sse]", "connection failed during handshake");
        setError({
          message: "Could not open the Planwerk event stream",
          code: "connection_refused",
          hint: "Reload Planwerk. VS Code local starts Agent Host automatically when AI features are enabled; no host configuration is required.",
        });
        es.close();
        eventSourceRef.current = null;
      } else {
        console.warn("[ahp:sse]", "stream error, browser will auto-reconnect");
      }
    };

    return () => {
      es.close();
      eventSourceRef.current = null;
    };
  }, [shouldConnect, hostUrl, workspaceScope, setCards, replaceCard, reconcileCard, addCard, removeCard, addFeedItem, setMonitoringStatus, setConnected, setError]);
}

interface HeartbeatActionData {
  type: string;
  cardId?: string;
  skillId?: string;
  from?: string;
  to?: string;
  message?: string;
  reason?: string;
  confirmed?: boolean;
  gateType?: string;
  status?: string;
  iteration?: number;
  otherCardId?: string;
  summary?: string;
}

function formatHeartbeatAction(action: HeartbeatActionData): { type: "intervention" | "suggestion" | "alert"; message: string } | null {
  switch (action.type) {
    case "review-injected":
      return {
        type: "intervention",
        message: `Auto-triggered ${action.skillId} review${action.iteration && action.iteration > 1 ? ` (iteration ${action.iteration})` : ""}.`,
      };
    case "review-passed":
      return {
        type: "suggestion",
        message: `${action.skillId} review passed ✓`,
      };
    case "phase-advanced":
      return {
        type: "intervention",
        message: `Auto-advanced from ${action.from} → ${action.to}.`,
      };
    case "nudge-sent":
      return {
        type: "suggestion",
        message: `Nudged idle session: "${action.message?.slice(0, 80)}"`,
      };
    case "escalated":
      return {
        type: "alert",
        message: `Escalated: ${action.reason ?? "Review requires human attention."}`,
      };
    case "gate-triggered":
      return {
        type: "intervention",
        message: `Triggered ${action.gateType} gate check.`,
      };
    case "auto-answered":
      return {
        type: "intervention",
        message: `Auto-answered pending input: "${(action as HeartbeatActionData & { answer?: string }).answer?.slice(0, 80) ?? ""}"`,
      };
    case "plan-approved":
      return {
        type: "intervention",
        message: "Auto-approved low-risk plan — proceeding to implementation.",
      };
    case "plan-approve-failed":
      return {
        type: "alert",
        message: `Plan approval not confirmed: ${action.reason ?? "the agent may still be stuck awaiting input."}`,
      };
    case "plan-review-passed":
      return {
        type: "intervention",
        message: "Configured plan review gates passed; plan remains ready for approval.",
      };
    case "plan-feedback-delivered":
      return {
        type: "intervention",
        message: "Returned configured plan-gate findings on the original plan request.",
      };
    case "plan-review-failed":
      return {
        type: "alert",
        message: `Plan review needs attention: ${action.reason ?? "configured gate execution or feedback delivery failed."}`,
      };
    case "risk-assessment-required":
    case "source-revision-required":
      return null;
    case "stale-gate-invalidated":
      return {
        type: "intervention",
        message: `Re-triggered stale ${action.gateType} gate (code changed since last run).`,
      };
    case "coherence-conflict":
      return {
        type: "alert",
        message: `Coherence conflict detected with another session${action.summary ? `: ${action.summary}` : "."}`,
      };
    case "coherence-blocked":
      return {
        type: "alert",
        message: action.reason ?? "Ship blocked by an unresolved coherence conflict.",
      };
    case "coherence-cleared":
      return {
        type: "suggestion",
        message: "Coherence check passed — no clash with the overlapping session ✓",
      };
    case "wip-violation":
      return {
        type: "alert",
        message: `WIP limit exceeded in ${(action as HeartbeatActionData & { phase?: string }).phase}: ${(action as HeartbeatActionData & { count?: number }).count}/${(action as HeartbeatActionData & { limit?: number }).limit} cards.`,
      };
    case "wip-cleared":
      return null;
    default:
      return null;
  }
}
