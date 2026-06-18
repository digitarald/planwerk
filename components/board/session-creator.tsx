"use client";

import { type FormEvent, useState } from "react";
import { Plus, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useConnectionStore } from "@/lib/store/connection-store";

export function SessionCreator() {
  const [isOpen, setIsOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleCreate = async (event: FormEvent) => {
    event.preventDefault();
    if (!title.trim() || isCreating) return;

    const trimmedTitle = title.trim();
    const { hostUrl, status: connStatus } = useConnectionStore.getState();

    if (connStatus !== "connected" || !hostUrl) {
      setError("Not connected to an AHP host");
      return;
    }

    setIsCreating(true);
    setError(null);
    try {
      const response = await fetch("/api/ahp/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hostUrl, title: trimmedTitle }),
      });

      if (!response.ok) {
        const data = await response.json();
        setError(data.error || "Failed to create session");
        setIsCreating(false);
        return;
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
      setIsCreating(false);
      return;
    }
    setIsCreating(false);

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
        <Button type="submit" size="sm" className="h-6 px-2 text-[10px]" disabled={!title.trim() || isCreating}>
          {isCreating ? "Creating..." : "Create"}
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
      {error && (
        <p className="text-[10px] text-destructive">{error}</p>
      )}
    </form>
  );
}
