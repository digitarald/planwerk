"use client";

import { useEffect } from "react";
import { useUIStore } from "@/lib/store/ui-store";
import { useInboxStore } from "@/lib/store/inbox-store";

export function DesktopNavigation() {
  useEffect(() => {
    const navigate = () => {
      const destination = window.location.hash;
      if (destination !== "#inbox" && destination !== "#board") return;
      useUIStore.getState().setWorkspaceMode(destination === "#inbox" ? "inbox" : "board");
      if (destination === "#inbox") useInboxStore.getState().setFilter("unread");
      window.history.replaceState(null, "", window.location.pathname + window.location.search);
    };
    navigate();
    window.addEventListener("hashchange", navigate);
    return () => window.removeEventListener("hashchange", navigate);
  }, []);
  return null;
}
