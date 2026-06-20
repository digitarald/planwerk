"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import Image from "next/image";
import { Eye, EyeOff, FolderOpen } from "lucide-react";

import { ConnectionDot } from "@/components/connection/connection-dot";
import {
  useBoardStore,
  selectWorkspaces,
  selectHasUnassigned,
  selectArchivedCount,
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

  const hideDone = useBoardStore((s) => s.hideDone);
  const toggleHideDone = useBoardStore((s) => s.toggleHideDone);
  const archivedCount = useBoardStore(selectArchivedCount);

  const isFiltered = workspaceFilters.size > 0;

  return (
    <header className="flex h-10 shrink-0 items-center border-b border-border/60 bg-background px-4 shadow-elevation-xs relative z-10">
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
        <WorkspaceChipBar
          workspaces={workspaces}
          workspaceFilters={workspaceFilters}
          isFiltered={isFiltered}
          hasUnassigned={hasUnassigned}
          toggleWorkspaceFilter={toggleWorkspaceFilter}
          clearWorkspaceFilters={clearWorkspaceFilters}
        />
      )}

      <div className="ml-auto flex shrink-0 items-center gap-3">
        {archivedCount > 0 && (
          <button
            onClick={toggleHideDone}
            aria-pressed={hideDone}
            title={hideDone ? `Show ${archivedCount} done` : "Hide done"}
            className={cn(
              "flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium transition-colors duration-200",
              hideDone
                ? "text-muted-foreground hover:bg-muted hover:text-foreground"
                : "bg-primary/10 text-primary"
            )}
          >
            {hideDone ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
            <span className="tabular-nums">{archivedCount}</span>
          </button>
        )}
        <ConnectionDot />
      </div>
    </header>
  );
}

/* ─── Workspace Chip Bar ─── */

interface WorkspaceChipBarProps {
  workspaces: ReturnType<typeof selectWorkspaces>;
  workspaceFilters: Set<string>;
  isFiltered: boolean;
  hasUnassigned: boolean;
  toggleWorkspaceFilter: (path: string) => void;
  clearWorkspaceFilters: () => void;
}

function WorkspaceChipBar({
  workspaces,
  workspaceFilters,
  isFiltered,
  hasUnassigned,
  toggleWorkspaceFilter,
  clearWorkspaceFilters,
}: WorkspaceChipBarProps) {
  const navRef = useRef<HTMLElement>(null);
  const [isOverflowing, setIsOverflowing] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);

  const checkOverflow = useCallback(() => {
    const el = navRef.current;
    if (!el) return;
    setIsOverflowing(el.scrollWidth > el.clientWidth + 2);
  }, []);

  useEffect(() => {
    const el = navRef.current;
    if (!el) return;
    checkOverflow();
    const ro = new ResizeObserver(checkOverflow);
    ro.observe(el);
    return () => ro.disconnect();
  }, [checkOverflow, workspaces, hasUnassigned]);

  const expand = useCallback(() => setIsExpanded(true), []);
  const collapse = useCallback(() => {
    setIsExpanded(false);
    // Reset scroll so chips don't strand mid-position
    if (navRef.current) navRef.current.scrollLeft = 0;
  }, []);

  const showFade = isOverflowing && !isExpanded;

  return (
    <div className="relative ml-6 flex min-w-0 flex-1 items-center">
      <nav
        ref={navRef}
        aria-label="Filter by workspace"
        onMouseEnter={expand}
        onMouseLeave={collapse}
        onFocusCapture={expand}
        onBlurCapture={collapse}
        className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto scrollbar-none"
      >
        <button
          onClick={clearWorkspaceFilters}
          aria-pressed={!isFiltered}
          className={cn(
            "shrink-0 rounded-full px-2.5 py-0.5 text-[11px] font-medium transition-colors duration-200",
            !isFiltered
              ? "bg-primary/10 text-primary"
              : "text-muted-foreground hover:bg-muted hover:text-foreground motion-safe:hover:scale-105"
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
                "flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-medium transition-colors duration-200",
                active
                  ? "bg-primary/10 text-primary"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground motion-safe:hover:scale-105"
              )}
            >
              {w.hasAttention && (
                <span className="h-1.5 w-1.5 rounded-full bg-amber-500 motion-safe:animate-pulse" />
              )}
              <span className="max-w-[120px] truncate">{w.name}</span>
              <span className="text-[10px] text-muted-foreground/60">{w.count}</span>
            </button>
          );
        })}
        {hasUnassigned && (
          <button
            onClick={() => toggleWorkspaceFilter(UNASSIGNED_WORKSPACE)}
            aria-pressed={workspaceFilters.has(UNASSIGNED_WORKSPACE)}
            className={cn(
              "flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-medium transition-colors duration-200",
              workspaceFilters.has(UNASSIGNED_WORKSPACE)
                ? "bg-primary/10 text-primary"
                : "text-muted-foreground hover:bg-muted hover:text-foreground motion-safe:hover:scale-105"
            )}
          >
            <FolderOpen className="h-3 w-3" />
            <span>Unassigned</span>
          </button>
        )}
      </nav>
      {/* Fade overlay — animates opacity instead of mask-image for smooth transitions */}
      <div
        aria-hidden
        className={cn(
          "pointer-events-none absolute inset-y-0 right-0 w-16 bg-gradient-to-l from-background to-transparent transition-opacity duration-300",
          showFade ? "opacity-100" : "opacity-0"
        )}
      />
    </div>
  );
}
