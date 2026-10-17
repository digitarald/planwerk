"use client";

import { AppShell } from "@/components/app-shell";
import { DesktopNavigation } from "@/components/desktop-navigation";
import { AgentWorkspace } from "@/components/agent-workspace";
import { CommandPalette } from "@/components/command-palette";
import { Onboarding } from "@/components/connection/onboarding";
import { LiveSessionProvider } from "@/components/live-session-provider";
import { NotificationProvider } from "@/components/notification-provider";
import { WelcomeModal } from "@/components/welcome-modal";
import { useConnectionStore } from "@/lib/store/connection-store";

export default function Home() {
  const status = useConnectionStore((state) => state.status);

  if (status === "disconnected") {
    return (
      <AppShell>
        <DesktopNavigation />
        <Onboarding />
      </AppShell>
    );
  }

  return (
    <NotificationProvider>
      <LiveSessionProvider>
        <AppShell>
          <DesktopNavigation />
          {status === "reconnecting" ? <Onboarding /> : <AgentWorkspace />}
          {status === "connected" && (
            <>
              <CommandPalette />
              <WelcomeModal />
            </>
          )}
        </AppShell>
      </LiveSessionProvider>
    </NotificationProvider>
  );
}
