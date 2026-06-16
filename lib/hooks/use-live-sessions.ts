"use client";

import { useEffect, useRef } from "react";

import { mapSessionToCard } from "@/lib/ahp/map-session";
import { AHPSessionSummary } from "@/lib/ahp/types";
import { useBoardStore } from "@/lib/store/board-store";
import { useConnectionStore } from "@/lib/store/connection-store";
import { useOrchestratorStore } from "@/lib/store/orchestrator-store";
import { KanbanCard } from "@/lib/types";

export function useLiveSessions() {
  const status = useConnectionStore((s) => s.status);
  const mode = useConnectionStore((s) => s.mode);
  const hostUrl = useConnectionStore((s) => s.hostUrl);
  const setConnected = useConnectionStore((s) => s.setConnected);
  const setError = useConnectionStore((s) => s.setError);
  const eventSourceRef = useRef<EventSource | null>(null);

  const setCards = useBoardStore((s) => s.setCards);
  const updateCard = useBoardStore((s) => s.updateCard);
  const addCard = useBoardStore((s) => s.addCard);
  const removeCard = useBoardStore((s) => s.removeCard);
  const getCard = useBoardStore((s) => s.getCard);
  const addFeedItem = useOrchestratorStore((s) => s.addFeedItem);

  useEffect(() => {
    // Only connect when status indicates we should be connected/connecting
    if (status !== "connected" && status !== "reconnecting") {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
      return;
    }

    // Build the SSE URL — pass host for remote mode
    let sseUrl = "/api/ahp/events";
    if (mode === "remote" && hostUrl && hostUrl !== "mock://localhost") {
      sseUrl += `?host=${encodeURIComponent(hostUrl)}`;
    }

    const es = new EventSource(sseUrl);
    eventSourceRef.current = es;

    es.onopen = () => {
      // SSE connected — mark connection as established
      if (status === "reconnecting") {
        setConnected();
      }
    };

    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);

        if (data.type === "error") {
          // Server-side connection error (e.g., AHP host unreachable)
          setError(data.message || "Connection error");
          es.close();
          eventSourceRef.current = null;
          return;
        }

        if (data.type === "init") {
          const cards: KanbanCard[] = data.sessions.map((s: AHPSessionSummary) =>
            mapSessionToCard(s, getCard(s.resource)?.phase)
          );
          setCards(cards);
          addFeedItem({
            type: "transition",
            message: `Connected. Monitoring ${data.sessions.length} sessions across the board.`,
          });
        } else if (data.type === "sessionSummaryChanged") {
          const session: AHPSessionSummary = data.session;
          const existing = getCard(session.resource);
          if (existing) {
            const updated = mapSessionToCard(session, existing.phase);
            updateCard(session.resource, updated);
            if (updated.attention === "needs-human" && existing.attention !== "needs-human") {
              addFeedItem({
                type: "alert",
                message: `"${updated.title}" needs your input: ${updated.activity}`,
                cardId: updated.id,
              });
            }
          } else {
            addCard(mapSessionToCard(session));
          }
        } else if (data.type === "sessionAdded") {
          addCard(mapSessionToCard(data.session));
        } else if (data.type === "sessionRemoved") {
          removeCard(data.resource);
        }
      } catch (e) {
        console.error("Failed to parse SSE event:", e);
      }
    };

    es.onerror = () => {
      if (status === "reconnecting") {
        // Failed during initial connection attempt
        setError("Could not connect. Is the AHP host running?");
        es.close();
        eventSourceRef.current = null;
      } else {
        console.warn("SSE connection error, will auto-reconnect");
      }
    };

    return () => {
      es.close();
      eventSourceRef.current = null;
    };
  }, [status, mode, hostUrl, setCards, updateCard, addCard, removeCard, getCard, addFeedItem, setConnected, setError]);
}
