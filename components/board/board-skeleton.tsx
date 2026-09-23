"use client";

import { Skeleton } from "@/components/ui/skeleton";
import { COLUMNS } from "@/lib/types";

function CardSkeleton() {
  return (
    <div className="space-y-2 rounded-md border border-border/60 bg-card p-2.5 shadow-elevation-xs">
      <div className="flex items-center gap-1.5">
        <Skeleton className="h-2 w-2 rounded-full" />
        <Skeleton className="h-3 w-3/4" />
      </div>
      <Skeleton className="ml-3.5 h-2.5 w-[calc(100%-0.875rem)]" />
      <Skeleton className="ml-3.5 h-1 w-1/2" />
    </div>
  );
}

export function BoardSkeleton() {
  return (
    <div className="h-full flex gap-0 overflow-x-auto p-4">
      {COLUMNS.map((column, index) => (
        <div key={column.id} className="flex flex-col min-w-[220px] w-[220px] flex-shrink-0">
          <div className="flex items-center gap-2 px-3 py-2">
            <Skeleton className="h-3 w-12" />
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
