"use client";

import { type FormEvent, useState } from "react";
import { Plus, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useBoardStore } from "@/lib/store/board-store";
import { type KanbanCard } from "@/lib/types";

export function SessionCreator() {
  const [isOpen, setIsOpen] = useState(false);
  const [title, setTitle] = useState("");
  const addCard = useBoardStore((state) => state.addCard);

  const handleCreate = (event: FormEvent) => {
    event.preventDefault();
    if (!title.trim()) return;

    const newCard: KanbanCard = {
      id: `new-${Date.now()}`,
      title: title.trim(),
      phase: "define",
      runtime: "idle",
      gateStatus: "pending",
      attention: "none",
      risk: "medium",
      activity: "Awaiting scope definition",
      additions: 0,
      deletions: 0,
      filesChanged: 0,
      planSteps: { total: 0, done: 0 },
      modifiedAt: Date.now(),
    };

    addCard(newCard);
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
