"use client";

import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { ConnectionStatus, useConnectionStore } from "@/lib/store/connection-store";
import { cn } from "@/lib/utils";

const statusConfig: Record<ConnectionStatus, { color: string; label: string }> = {
  connected: { color: "bg-emerald-500", label: "Connected" },
  reconnecting: { color: "bg-amber-500 animate-pulse", label: "Reconnecting..." },
  disconnected: { color: "bg-red-500", label: "Disconnected" },
};

export function ConnectionDot() {
  const status = useConnectionStore((state) => state.status);
  const hostUrl = useConnectionStore((state) => state.hostUrl);
  const config = statusConfig[status];

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger className="flex cursor-default items-center gap-1.5 rounded-sm bg-transparent p-0 text-left outline-none">
          <div>
            <div className={cn("h-2 w-2 rounded-full", config.color)} />
          </div>
          <span className="text-xs text-muted-foreground">{config.label}</span>
        </TooltipTrigger>
        <TooltipContent>
          <p>{hostUrl || "No AHP host configured"}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
