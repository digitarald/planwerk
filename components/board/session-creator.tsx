"use client";

import { type FormEvent, useState } from "react";
import { Plus, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useBoardStore, selectWorkspaces } from "@/lib/store/board-store";
import { useConnectionStore } from "@/lib/store/connection-store";
import { useShallow } from "zustand/react/shallow";
import { type KanbanCard } from "@/lib/types";

export function SessionCreator() {
  const [isOpen, setIsOpen] = useState(false);
  const [title, setTitle] = useState("");
  const addCard = useBoardStore((state) => state.addCard);
  const workspaceFilters = useBoardStore((state) => state.workspaceFilters);
  const workspaces = useBoardStore(useShallow(selectWorkspaces));

  // Inherit workspace when exactly one non-sentinel filter is active
  const inheritedProject = (() => {
    if (workspaceFilters.size !== 1) return undefined;
    const [filterPath] = workspaceFilters;
    const ws = workspaces.find((w) => w.path === filterPath);
    return ws ? { name: ws.name, path: ws.path } : undefined;
  })();

  const handleCreate = async (event: FormEvent) => {
    event.preventDefault();
    if (!title.trim()) return;

    const trimmedTitle = title.trim();
    const { mode, hostUrl } = useConnectionStore.getState();

    if (mode === "remote" && hostUrl) {
      try {
        const response = await fetch("/api/ahp/sessions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ hostUrl, title: trimmedTitle }),
        });

        if (!response.ok) {
          const data = await response.json();
          console.error("Failed to create session:", data.error);
        }
      } catch (err) {
        console.error("Failed to create session:", err);
      }
    } else {
      const newCard: KanbanCard = {
        id: `new-${Date.now()}`,
        title: trimmedTitle,
        phase: "define",
        runtime: "idle",
        gateStatus: "pending",
        attention: "none",
        risk: "low",
        activity: "Awaiting scope definition",
        additions: 0,
        deletions: 0,
        filesChanged: 0,
        planSteps: { total: 0, done: 0 },
        modifiedAt: Date.now(),
        project: inheritedProject,
      };

      addCard(newCard);
    }

    setTitle("");
    setIsOpen(false);
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
    <form onSubmit={handleCreate} className="space-y-1.5 px-2">
      <Input
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        placeholder="Task title..."
        className="h-7 text-xs"
        autoFocus
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            setIsOpen(false);
            setTitle("");
          }
        }}
      />
      <div className="flex gap-1">
        <Button type="submit" size="sm" className="h-6 px-2 text-[10px]" disabled={!title.trim()}>
          Create
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-6 px-2 text-[10px]"
          onClick={() => {
            setIsOpen(false);
            setTitle("");
          }}
        >
          <X className="h-3 w-3" />
        </Button>
      </div>
    </form>
  );
}
