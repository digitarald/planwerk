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
          addFeedItem({
            type: "transition",
            message: `Connected. Monitoring ${data.cards.length} sessions across the board.`,
          });
        } else if (data.type === "cardChanged") {
          const card = data.card;
          const existing = useBoardStore.getState().getCard(card.id);
          if (existing) {
            updateCard(card.id, card);
            if (card.attention === "needs-human" && existing.attention !== "needs-human") {
              addFeedItem({
                type: "alert",
                message: `"${card.title}" needs your input: ${card.activity}`,
                cardId: card.id,
              });
            }
          } else {
            addCard(card);
          }
        } else if (data.type === "cardRemoved") {
          removeCard(data.cardId);
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
  }, [status, hostUrl, setCards, updateCard, addCard, removeCard, addFeedItem, setConnected, setError]);
}
