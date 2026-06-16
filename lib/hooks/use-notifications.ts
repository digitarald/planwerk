"use client";

import { useEffect, useRef } from "react";

import { useBoardStore } from "@/lib/store/board-store";

export function useDesktopNotifications() {
  const cards = useBoardStore((s) => s.cards);
  const prevAttentionRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    // Don't request immediately — wait until we actually need to notify
  }, []);

  useEffect(() => {
    const count = cards.filter((c) => c.attention !== "none").length;
    document.title = count > 0 ? `(${count}) Planwerk` : "Planwerk";
  }, [cards]);

  useEffect(() => {
    if (!("Notification" in window)) return;
    if (Notification.permission === "denied") return;

    if (Notification.permission === "default") {
      Notification.requestPermission();
      return;
    }

    const currentAttention = new Set(cards.filter((c) => c.attention !== "none").map((c) => c.id));

    for (const id of currentAttention) {
      if (!prevAttentionRef.current.has(id)) {
        const card = cards.find((c) => c.id === id);
        if (card) {
          const typeLabel =
            card.attention === "needs-human"
              ? "needs your input"
              : card.attention === "error"
                ? "has an error"
                : "needs attention";

          new Notification(`Planwerk: ${card.title}`, {
            body: `Session ${typeLabel}`,
            icon: "/favicon.ico",
            tag: card.id,
          });
        }
      }
    }

    prevAttentionRef.current = currentAttention;
  }, [cards]);
}
