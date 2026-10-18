"use client";

import { useEffect } from "react";
import { CoordinatorDrawer } from "@/components/orchestrator/coordinator-drawer";
import { TitleBar } from "@/components/title-bar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useCoordinatorPolicyHydration } from "@/lib/hooks/use-coordinator-policy-hydration";
import { uiAfterPaint, uiMark } from "@/lib/diagnostics/ui-performance-client";

interface AppShellProps {
  children: React.ReactNode;
}

export function AppShell({ children }: AppShellProps) {
  useCoordinatorPolicyHydration();
  useEffect(() => {
    uiMark("shell.commit", undefined, true);
    return uiAfterPaint("shell.paint-opportunity");
  }, []);

  return (
    <TooltipProvider delay={250}>
      <div className="flex h-full flex-col">
        <TitleBar />
        <main className="relative min-h-0 min-w-0 flex-1 bg-[var(--pw-board-bg)]">{children}</main>
        <CoordinatorDrawer />
      </div>
    </TooltipProvider>
  );
}
