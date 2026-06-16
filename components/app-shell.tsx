"use client";

import { TitleBar } from "@/components/title-bar";
import { OrchestratorFeed } from "@/components/orchestrator/feed";

interface AppShellProps {
  children: React.ReactNode;
}

export function AppShell({ children }: AppShellProps) {
  return (
    <div className="flex h-full flex-col">
      <TitleBar />
      <div className="flex min-h-0 flex-1">
        <aside className="flex min-h-0 w-80 flex-col border-r border-border bg-muted/50">
          <OrchestratorFeed />
        </aside>
        <main className="min-h-0 min-w-0 flex-1">{children}</main>
      </div>
    </div>
  );
}
