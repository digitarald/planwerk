"use client";

import { type FormEvent, useMemo, useState } from "react";
import { Plus, X, Sparkles, Loader2, FolderGit2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useConnectionStore } from "@/lib/store/connection-store";
import {
  useBoardStore,
  selectWorkspaces,
  UNASSIGNED_WORKSPACE,
} from "@/lib/store/board-store";
import { usePersistentState } from "@/lib/hooks/use-persistent-state";

const LAST_WORKSPACE_KEY = "planwerk-last-workspace";

export function SessionCreator() {
  const [isOpen, setIsOpen] = useState(false);
  const [task, setTask] = useState("");
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const workspaces = useBoardStore(selectWorkspaces);
  // Known, assignable workspaces (a real path — not the "unassigned" bucket).
  const options = useMemo(
    () => workspaces.filter((w) => w.path && w.path !== UNASSIGNED_WORKSPACE),
    [workspaces],
  );

  const [workspace, setWorkspace] = usePersistentState(
    LAST_WORKSPACE_KEY,
    options[0]?.path ?? "",
  );
  // Fall back to the first known workspace if the remembered one is gone.
  const selectedPath =
    options.find((w) => w.path === workspace)?.path ?? options[0]?.path ?? "";

  const reset = () => {
    setTask("");
    setError(null);
    setIsOpen(false);
  };

  const handleCreate = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = task.trim();
    if (!trimmed || isCreating) return;

    const { hostUrl, status: connStatus } = useConnectionStore.getState();
    if (connStatus !== "connected" || !hostUrl) {
      setError("Not connected to an AHP host");
      return;
    }
    if (!selectedPath) {
      setError("Pick a workspace for this task");
      return;
    }

    setIsCreating(true);
    setError(null);
    try {
      const response = await fetch("/api/ahp/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          hostUrl,
          prompt: trimmed,
          workingDirectory: selectedPath,
        }),
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        setError(data.error || "Failed to create task");
        setIsCreating(false);
        return;
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
      setIsCreating(false);
      return;
    }

    setIsCreating(false);
    reset();
  };

  if (!isOpen) {
    return (
      <button
        type="button"
        onClick={() => setIsOpen(true)}
        className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
      >
        <Plus className="h-3.5 w-3.5" />
        <span>New task</span>
      </button>
    );
  }

  return (
    <form
      onSubmit={handleCreate}
      className="space-y-2 rounded-lg border border-border/70 bg-card p-2 shadow-elevation-xs"
    >
      <Textarea
        value={task}
        onChange={(event) => setTask(event.target.value)}
        placeholder="Describe the task…"
        rows={3}
        autoFocus
        className="min-h-[60px] resize-none text-[13px] leading-relaxed"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            reset();
          } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            void handleCreate(event);
          }
        }}
      />

      {/* Workspace picker */}
      <label className="flex items-center gap-1.5 rounded-md border border-input bg-transparent px-2 py-1 text-[11px] focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50">
        <FolderGit2 className="h-3 w-3 shrink-0 text-muted-foreground" />
        {options.length > 0 ? (
          <select
            value={selectedPath}
            onChange={(event) => setWorkspace(event.target.value)}
            className="min-w-0 flex-1 cursor-pointer bg-transparent text-foreground outline-none"
            aria-label="Workspace"
          >
            {options.map((w) => (
              <option key={w.path} value={w.path}>
                {w.name}
              </option>
            ))}
          </select>
        ) : (
          <span className="flex-1 text-muted-foreground">
            No workspaces available yet
          </span>
        )}
      </label>

      {/* Plan-mode hint */}
      <div className="flex items-center gap-1 px-0.5 text-[10px] text-muted-foreground/80">
        <Sparkles className="h-2.5 w-2.5 text-primary/70" />
        <span>Starts in Plan mode · approvals bypassed</span>
      </div>

      <div className="flex gap-1">
        <Button
          type="submit"
          size="sm"
          className="h-6 flex-1 gap-1 px-2 text-[10px]"
          disabled={!task.trim() || !selectedPath || isCreating}
        >
          {isCreating ? (
            <>
              <Loader2 className="h-3 w-3 animate-spin" />
              Starting…
            </>
          ) : (
            "Create task"
          )}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-6 px-2 text-[10px]"
          onClick={reset}
          disabled={isCreating}
        >
          <X className="h-3 w-3" />
        </Button>
      </div>

      {error && <p className="text-[10px] text-destructive">{error}</p>}
    </form>
  );
}
