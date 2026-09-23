"use client";

import { useEffect, useRef } from "react";

import { useInboxStore } from "@/lib/store/inbox-store";

export function useDesktopNotifications() {
  const items = useInboxStore((s) => s.items);
  const unreadCount = useInboxStore((s) => s.counts.unread);
  const previousUrgentRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    document.title = unreadCount > 0 ? `(${unreadCount}) Planwerk` : "Planwerk";
  }, [unreadCount]);

  useEffect(() => {
    if (!("Notification" in window)) return;
    if (Notification.permission === "denied") return;

    const urgentItems = items.filter(
      (item) =>
        item.workflowState === "open"
        && item.readAt === null
        && item.category !== "read"
        && item.priorityBand <= 2,
    );
    const currentUrgent = new Set(urgentItems.map((item) => item.id));

    if (urgentItems.length === 0) {
      previousUrgentRef.current = currentUrgent;
      return;
    }

    if (Notification.permission === "default") {
      void Notification.requestPermission();
      previousUrgentRef.current = currentUrgent;
      return;
    }

    for (const item of urgentItems) {
      if (!previousUrgentRef.current.has(item.id)) {
          new Notification(`Planwerk: ${item.title}`, {
            body: item.briefing.recommendation,
            icon: "/favicon.ico",
            tag: `inbox:${item.id}`,
          });
      }
    }

    previousUrgentRef.current = currentUrgent;
  }, [items]);
}
