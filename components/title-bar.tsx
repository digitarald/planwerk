"use client";

import { Activity } from "lucide-react";

import { ConnectionDot } from "@/components/connection/connection-dot";
import { useBoardStore } from "@/lib/store/board-store";

export function TitleBar() {
  const cards = useBoardStore((s) => s.cards);
  const attentionCount = cards.filter((c) => c.attention !== "none").length;

  return (
    <header className="flex h-10 shrink-0 items-center border-b border-border bg-background px-4">
      <div className="flex items-center gap-2">
        <Activity className="h-4 w-4 text-primary" />
        <span className="text-sm font-semibold">Planwerk</span>
        {attentionCount > 0 && (
          <span className="ml-2 flex h-4 min-w-4 items-center justify-center rounded-full bg-amber-500 px-1 text-[10px] font-bold text-white">
            {attentionCount}
          </span>
        )}
      </div>
      <div className="flex-1" />
      <div className="flex items-center gap-3">
        <ConnectionDot />
      </div>
    </header>
  );
}
