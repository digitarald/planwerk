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
  const eventSourceRef = useRef<EventSource | null>(null);

  const setCards = useBoardStore((s) => s.setCards);
  const updateCard = useBoardStore((s) => s.updateCard);
  const addCard = useBoardStore((s) => s.addCard);
  const removeCard = useBoardStore((s) => s.removeCard);
  const getCard = useBoardStore((s) => s.getCard);
  const addFeedItem = useOrchestratorStore((s) => s.addFeedItem);

  useEffect(() => {
    if (status !== "connected") {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
      return;
    }

    const es = new EventSource("/api/ahp/events");
    eventSourceRef.current = es;

    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);

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
      console.warn("SSE connection error, will auto-reconnect");
    };

    return () => {
      es.close();
      eventSourceRef.current = null;
    };
  }, [status, setCards, updateCard, addCard, removeCard, getCard, addFeedItem]);
}
