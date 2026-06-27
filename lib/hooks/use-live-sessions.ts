"use client";

import { useEffect, useRef } from "react";

import { useBoardStore } from "@/lib/store/board-store";
import { useConnectionStore } from "@/lib/store/connection-store";
import { useOrchestratorStore } from "@/lib/store/orchestrator-store";

export function useLiveSessions() {
  const status = useConnectionStore((s) => s.status);
  const hostUrl = useConnectionStore((s) => s.hostUrl);
  const setConnected = useConnectionStore((s) => s.setConnected);
  const setError = useConnectionStore((s) => s.setError);
  const eventSourceRef = useRef<EventSource | null>(null);

  const setCards = useBoardStore((s) => s.setCards);
  const updateCard = useBoardStore((s) => s.updateCard);
  const addCard = useBoardStore((s) => s.addCard);
  const removeCard = useBoardStore((s) => s.removeCard);
  const addFeedItem = useOrchestratorStore((s) => s.addFeedItem);
  const upsertTransition = useOrchestratorStore((s) => s.upsertTransition);

  useEffect(() => {
    // Only connect when status indicates we should be connected/connecting
    if (status !== "connected" && status !== "reconnecting") {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
      return;
    }

    // Build the SSE URL — pass host when available
    let sseUrl = "/api/ahp/events";
    if (hostUrl) {
      sseUrl += `?host=${encodeURIComponent(hostUrl)}`;
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
          setConnected();
          const { hasConnectedOnce } = useOrchestratorStore.getState();
          if (hasConnectedOnce) {
            upsertTransition(`Reconnected. Monitoring ${data.cards.length} sessions.`);
          } else {
            upsertTransition(`Monitoring ${data.cards.length} sessions.`);
          }
        } else if (data.type === "cardChanged") {
          const card = data.card;
          const existing = useBoardStore.getState().getCard(card.id);
          if (existing) {
            updateCard(card.id, card);
            if (card.attention === "needs-human" && existing.attention !== "needs-human") {
              addFeedItem({
                type: "alert",
                message: card.activity,
                cardId: card.id,
                cardTitle: card.title,
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
              });
            }
          } else {
            addCard(card);
          }
        } else if (data.type === "cardRemoved") {
          removeCard(data.cardId);
        } else if (data.type === "heartbeat") {
          // Heartbeat action from the autonomous loop
          const action = data.action;
          if (action) {
            const feedMsg = formatHeartbeatAction(action);
            if (feedMsg) {
              addFeedItem({
                type: feedMsg.type,
                message: feedMsg.message,
                cardId: action.cardId,
                cardTitle: useBoardStore.getState().getCard(action.cardId)?.title,
              });
            }
          }
        }
      } catch (e) {
        console.error("Failed to parse SSE event:", e);
      }
    };

    es.onerror = () => {
      if (status === "reconnecting") {
        // Failed during initial connection attempt
        console.error("[ahp:sse]", "connection failed during handshake");
        setError({
          message: "Could not connect to the AHP host",
          code: "connection_refused",
          hint: "Make sure the agent host server is running. In VS Code, enable \"Chat: Agent Host\" in settings, or start it manually.",
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
  }, [status, hostUrl, setCards, updateCard, addCard, removeCard, addFeedItem, upsertTransition, setConnected, setError]);
}

interface HeartbeatActionData {
  type: string;
  cardId?: string;
  skillId?: string;
  from?: string;
  to?: string;
  message?: string;
  reason?: string;
  gateType?: string;
  iteration?: number;
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
    case "plan-rubber-ducked":
      return {
        type: "intervention",
        message: "Sent plan back for a rubber-duck review before approval.",
      };
    case "stale-gate-invalidated":
      return {
        type: "intervention",
        message: `Re-triggered stale ${action.gateType} gate (code changed since last run).`,
      };
    case "wip-violation":
      return {
        type: "alert",
        message: `WIP limit exceeded in ${(action as HeartbeatActionData & { phase?: string }).phase}: ${(action as HeartbeatActionData & { count?: number }).count}/${(action as HeartbeatActionData & { limit?: number }).limit} cards.`,
      };
    default:
      return null;
  }
}
