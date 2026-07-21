"use client";

import { PanelLeftClose, PanelLeftOpen } from "lucide-react";

import { TitleBar } from "@/components/title-bar";
import { OrchestratorFeed } from "@/components/orchestrator/feed";
import { usePersistentState } from "@/lib/hooks/use-persistent-state";
import { cn } from "@/lib/utils";

interface AppShellProps {
  children: React.ReactNode;
}

const SIDEBAR_KEY = "planwerk:sidebar-collapsed";

export function AppShell({ children }: AppShellProps) {
  const [collapsedValue, setCollapsedValue] = usePersistentState(SIDEBAR_KEY, "false");
  const collapsed = collapsedValue === "true";

  const toggle = () => {
    setCollapsedValue(String(!collapsed));
  };

  return (
    <div className="flex h-full flex-col">
      <TitleBar />
      <div className="flex min-h-0 flex-1">
        <aside
          className={cn(
            "relative z-base flex min-h-0 flex-col bg-muted/50 shadow-elevation-md transition-[width] duration-200",
            collapsed ? "w-12" : "w-72"
          )}
        >
          <div className="flex items-center justify-end px-2 py-1.5">
            <button
              onClick={toggle}
              className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
              aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            >
              {collapsed ? (
                <PanelLeftOpen className="h-4 w-4" />
              ) : (
                <PanelLeftClose className="h-4 w-4" />
              )}
            </button>
          </div>
          {!collapsed && <OrchestratorFeed />}
        </aside>
        <main className="relative min-h-0 min-w-0 flex-1 bg-[var(--pw-board-bg)]">{children}</main>
      </div>
    </div>
  );
}
