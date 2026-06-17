"use client";

import { useShallow } from "zustand/react/shallow";
import Image from "next/image";
import { FolderOpen } from "lucide-react";

import { ConnectionDot } from "@/components/connection/connection-dot";
import {
  useBoardStore,
  selectWorkspaces,
  selectHasUnassigned,
  UNASSIGNED_WORKSPACE,
} from "@/lib/store/board-store";
import { cn } from "@/lib/utils";

export function TitleBar() {
  const cards = useBoardStore((s) => s.cards);
  const attentionCount = cards.filter((c) => c.attention !== "none").length;

  const workspaceFilters = useBoardStore((s) => s.workspaceFilters);
  const toggleWorkspaceFilter = useBoardStore((s) => s.toggleWorkspaceFilter);
  const clearWorkspaceFilters = useBoardStore((s) => s.clearWorkspaceFilters);
  const workspaces = useBoardStore(useShallow(selectWorkspaces));
  const hasUnassigned = useBoardStore(selectHasUnassigned);

  const isFiltered = workspaceFilters.size > 0;

  return (
    <header className="flex h-10 shrink-0 items-center border-b border-border bg-background px-4">
      <div className="flex items-center gap-2">
        <Image src="/logo-light-64.png" alt="Planwerk" width={28} height={28} className="dark:hidden" />
        <Image src="/logo-dark-64.png" alt="Planwerk" width={28} height={28} className="hidden dark:block" />
        <span className="text-sm font-semibold">Planwerk</span>
        {attentionCount > 0 && (
          <span className="ml-2 flex h-4 min-w-4 items-center justify-center rounded-full bg-amber-500 px-1 text-[10px] font-bold text-white">
            {attentionCount}
          </span>
        )}
      </div>

      {/* Workspace chip bar */}
      {workspaces.length > 0 && (
        <nav
          aria-label="Filter by workspace"
          className="ml-6 flex min-w-0 items-center gap-1 overflow-x-auto"
        >
          <button
            onClick={clearWorkspaceFilters}
            aria-pressed={!isFiltered}
            className={cn(
              "shrink-0 rounded-full px-2.5 py-0.5 text-[11px] font-medium transition-colors",
              !isFiltered
                ? "bg-primary/10 text-primary"
                : "text-muted-foreground hover:bg-muted hover:text-foreground"
            )}
          >
            All
          </button>
          {workspaces.map((w) => {
            const active = workspaceFilters.has(w.path);
            return (
              <button
                key={w.path}
                onClick={() => toggleWorkspaceFilter(w.path)}
                aria-pressed={active}
                className={cn(
                  "flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-medium transition-colors",
                  active
                    ? "bg-primary/10 text-primary"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground"
                )}
              >
                {w.hasAttention && (
                  <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
                )}
                <span>{w.name}</span>
                <span className="text-[10px] text-muted-foreground/60">{w.count}</span>
              </button>
            );
          })}
          {hasUnassigned && (
            <button
              onClick={() => toggleWorkspaceFilter(UNASSIGNED_WORKSPACE)}
              aria-pressed={workspaceFilters.has(UNASSIGNED_WORKSPACE)}
              className={cn(
                "flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-medium transition-colors",
                workspaceFilters.has(UNASSIGNED_WORKSPACE)
                  ? "bg-primary/10 text-primary"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground"
              )}
            >
              <FolderOpen className="h-3 w-3" />
              <span>Unassigned</span>
            </button>
          )}
        </nav>
      )}

      <div className="flex-1" />
      <div className="flex shrink-0 items-center gap-3">
        <ConnectionDot />
      </div>
    </header>
  );
}
