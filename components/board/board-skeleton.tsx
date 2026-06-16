"use client";

import { COLUMNS } from "@/lib/types";

function CardSkeleton() {
  return (
    <div className="bg-card border border-border rounded-md p-2.5 space-y-2 animate-pulse">
      <div className="flex items-center gap-1.5">
        <div className="h-2 w-2 rounded-full bg-muted" />
        <div className="h-3 bg-muted rounded w-3/4" />
      </div>
      <div className="h-2.5 bg-muted rounded w-full ml-3.5" />
      <div className="h-1 bg-muted rounded w-1/2 ml-3.5" />
    </div>
  );
}

export function BoardSkeleton() {
  return (
    <div className="h-full flex gap-0 overflow-x-auto p-4">
      {COLUMNS.map((column, index) => (
        <div key={column.id} className="flex flex-col min-w-[220px] w-[220px] flex-shrink-0">
          <div className="flex items-center gap-2 px-3 py-2">
            <div className="h-3 w-12 bg-muted rounded animate-pulse" />
          </div>
          <div className="space-y-2 px-2">
            {Array.from({ length: (index % 2) + 1 }).map((_, i) => (
              <CardSkeleton key={i} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
