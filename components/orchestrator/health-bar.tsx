"use client";

import { useBoardStore } from "@/lib/store/board-store";

interface HealthBarProps {
  active: number;
  idle: number;
  errors: number;
  needsInput: number;
}

export function HealthBar({ active, idle, errors, needsInput }: HealthBarProps) {
  const setDetailCard = useBoardStore((s) => s.setDetailCard);
  const cards = useBoardStore((s) => s.cards);

  const handleInputClick = () => {
    const first = cards.find((c) => c.runtime === "input-needed");
    if (first) setDetailCard(first.id);
  };

  const handleErrorClick = () => {
    const first = cards.find((c) => c.runtime === "error");
    if (first) setDetailCard(first.id);
  };

  return (
    <div className="px-3 py-1.5">
      <div className="flex items-center gap-2.5 text-[10px]">
        <span className="text-emerald-600">{active} active</span>
        <span className="text-muted-foreground">{idle} idle</span>
        {errors > 0 && (
          <button
            onClick={handleErrorClick}
            className="text-red-600 hover:underline underline-offset-2"
          >
            {errors} error{errors !== 1 && "s"}
          </button>
        )}
        {needsInput > 0 && (
          <button
            onClick={handleInputClick}
            className="text-amber-600 hover:underline underline-offset-2 font-medium"
          >
            {needsInput} need{needsInput === 1 ? "s" : ""} input
          </button>
        )}
      </div>
    </div>
  );
}
