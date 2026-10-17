"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useShallow } from "zustand/react/shallow";
import Image from "next/image";
import { Bot, Columns3, Eye, EyeOff, FolderOpen, ListTree, PanelTop } from "lucide-react";

import { ConnectionDot } from "@/components/connection/connection-dot";
import { TooltipHint } from "@/components/ui/tooltip";
import {
  useBoardStore,
  selectWorkspaces,
  selectHasUnassigned,
  selectArchivedCount,
  UNASSIGNED_WORKSPACE,
} from "@/lib/store/board-store";
import {
  filterInboxItemsByWorkspace,
  inboxCountsFor,
  useInboxStore,
} from "@/lib/store/inbox-store";
import { useConnectionStore } from "@/lib/store/connection-store";
import { useUIStore, type WorkspaceMode } from "@/lib/store/ui-store";
import { ATTENTION_META, highestAttention } from "@/lib/utils/attention";
import { cn } from "@/lib/utils";

const subscribeDesktop = () => () => {};
const isDesktop = () => Reflect.get(window, "__PLANWERK_DESKTOP__") === true;
const isWebServer = () => false;

export function TitleBar() {
  const desktop = useSyncExternalStore(subscribeDesktop, isDesktop, isWebServer);
  const cards = useBoardStore((s) => s.cards);
  const attentionCount = cards.filter((c) => c.attention !== "none").length;
  const topAttention = highestAttention(cards);

  const workspaceFilters = useBoardStore((s) => s.workspaceFilters);
  const toggleWorkspaceFilter = useBoardStore((s) => s.toggleWorkspaceFilter);
  const clearWorkspaceFilters = useBoardStore((s) => s.clearWorkspaceFilters);
  const workspaces = useBoardStore(useShallow(selectWorkspaces));
  const hasUnassigned = useBoardStore(selectHasUnassigned);

  const hideDone = useBoardStore((s) => s.hideDone);
  const toggleHideDone = useBoardStore((s) => s.toggleHideDone);
  const archivedCount = useBoardStore(selectArchivedCount);
  const inboxItems = useInboxStore((s) => s.items);
  const serverInboxCounts = useInboxStore((s) => s.counts);
  const inboxCounts = workspaceFilters.size === 0
    ? serverInboxCounts
    : inboxCountsFor(
        filterInboxItemsByWorkspace(inboxItems, cards, workspaceFilters),
      );
  const workspaceMode = useUIStore((s) => s.workspaceMode);
  const setWorkspaceMode = useUIStore((s) => s.setWorkspaceMode);
  const openCoordinator = useUIStore((s) => s.openCoordinator);
  const connectionStatus = useConnectionStore((s) => s.status);

  const isFiltered = workspaceFilters.size > 0;

  return (
    <header data-desktop-titlebar={desktop || undefined} className={cn(
      "relative z-sticky flex h-11 shrink-0 items-center border-b border-border/60 bg-background px-3 shadow-elevation-xs sm:px-4",
      desktop && "select-none !pl-[88px]",
    )}>
      <div className="flex shrink-0 items-center gap-2.5">
        <Image src="/logo-light-64.png" alt="Planwerk" width={24} height={24} className="dark:hidden" />
        <Image src="/logo-dark-64.png" alt="Planwerk" width={24} height={24} className="hidden dark:block" />
        <span className="hidden text-[15px] font-semibold tracking-[-0.01em] min-[520px]:inline">
          Planwerk
        </span>
        {attentionCount > 0 && topAttention !== "none" && (() => {
          const { Icon, pill, label } = ATTENTION_META[topAttention];
          return (
            <TooltipHint
              label={`${attentionCount} ${attentionCount === 1 ? "session needs" : "sessions need"} attention. Highest severity: ${label}. Open the Feed to review.`}
              className={cn(
                "inline-flex h-5 items-center gap-1 rounded-full px-1.5 text-[10px] font-bold tabular-nums shadow-elevation-xs min-[520px]:ml-1",
                pill
              )}
            >
              <Icon className="h-3 w-3" />
              {attentionCount}
            </TooltipHint>
          );
        })()}
      </div>

      <WorkspaceModeControl value={workspaceMode} onChange={setWorkspaceMode} />

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

      <div className="ml-auto flex shrink-0 items-center gap-1.5 sm:gap-3">
        {connectionStatus === "connected" && inboxCounts.unread > 0 && (
          <button
            type="button"
            onClick={() => setWorkspaceMode("inbox")}
            aria-label={`${inboxCounts.unread} new item${inboxCounts.unread === 1 ? "" : "s"}`}
            className="inline-flex items-center gap-1 rounded-md bg-primary/10 px-2 py-1 text-[10px] font-semibold text-primary hover:bg-primary/15"
            title={`${inboxCounts.unread} new item${inboxCounts.unread === 1 ? "" : "s"}`}
          >
            <ListTree className="h-3 w-3" />
            {inboxCounts.unread}
          </button>
        )}
        {archivedCount > 0 && (
          <button
            onClick={toggleHideDone}
            aria-pressed={hideDone}
            aria-label={hideDone ? `Show ${archivedCount} done sessions` : "Hide done sessions"}
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
        <button
          type="button"
          onClick={openCoordinator}
          className="hidden h-7 items-center gap-1.5 rounded-md px-2 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground min-[520px]:inline-flex"
          aria-label="Open coordinator"
          title="Open coordinator"
        >
          <Bot className="h-3.5 w-3.5" />
          <span className="hidden xl:inline">Coordinator</span>
        </button>
        <ConnectionDot />
      </div>
    </header>
  );
}

const workspaceModes: Array<{
  id: WorkspaceMode;
  label: string;
  icon: typeof ListTree;
}> = [
  { id: "inbox", label: "Feed", icon: ListTree },
  { id: "split", label: "Split", icon: PanelTop },
  { id: "board", label: "Board", icon: Columns3 },
];

function WorkspaceModeControl({
  value,
  onChange,
}: {
  value: WorkspaceMode;
  onChange: (mode: WorkspaceMode) => void;
}) {
  return (
    <div
      className="ml-3 flex shrink-0 items-center rounded-lg border border-border/70 bg-muted/40 p-0.5 sm:ml-5"
      role="group"
      aria-label="Workspace view"
    >
      {workspaceModes.map(({ id, label, icon: Icon }) => (
        <button
          key={id}
          type="button"
          aria-pressed={value === id}
          aria-label={`${label} view`}
          title={`${label} view`}
          onClick={() => onChange(id)}
          className={cn(
            "inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[11px] font-medium transition-colors duration-150 active:scale-[0.97] motion-reduce:transform-none",
            value === id
              ? "bg-background text-foreground shadow-elevation-xs"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          <Icon className="h-3.5 w-3.5" />
          <span className="hidden lg:inline">{label}</span>
        </button>
      ))}
    </div>
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
    <div className="relative ml-6 hidden min-w-0 flex-1 items-center min-[800px]:flex">
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
                <TooltipHint label={`${w.name} has sessions that need attention`}>
                  <span className="h-1.5 w-1.5 rounded-full bg-amber-500 motion-safe:animate-pulse" />
                </TooltipHint>
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
