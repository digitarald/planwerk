"use client";

import { AppShell } from "@/components/app-shell";
import { KanbanBoard } from "@/components/board/kanban-board";
import { CommandPalette } from "@/components/command-palette";
import { Onboarding } from "@/components/connection/onboarding";
import { LiveSessionProvider } from "@/components/live-session-provider";
import { NotificationProvider } from "@/components/notification-provider";
import { useConnectionStore } from "@/lib/store/connection-store";

export default function Home() {
  const status = useConnectionStore((state) => state.status);

  if (status !== "connected") {
    return (
      <AppShell>
        <Onboarding />
      </AppShell>
    );
  }

  return (
    <NotificationProvider>
      <LiveSessionProvider>
        <AppShell>
          <KanbanBoard />
          <CommandPalette />
        </AppShell>
      </LiveSessionProvider>
    </NotificationProvider>
  );
}
