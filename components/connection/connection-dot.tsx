"use client";

import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { ConnectionStatus, useConnectionStore } from "@/lib/store/connection-store";
import { cn } from "@/lib/utils";

const statusConfig: Record<ConnectionStatus, { color: string; label: string }> = {
  connected: { color: "bg-emerald-500", label: "Connected" },
  reconnecting: { color: "bg-amber-500 animate-pulse", label: "Connecting..." },
  disconnected: { color: "bg-red-500", label: "Disconnected" },
};

export function ConnectionDot() {
  const status = useConnectionStore((state) => state.status);
  const mode = useConnectionStore((state) => state.mode);
  const hostUrl = useConnectionStore((state) => state.hostUrl);
  const error = useConnectionStore((state) => state.error);
  const connect = useConnectionStore((state) => state.connect);
  const config = statusConfig[status];

  const canRetry = status === "disconnected" && hostUrl;

  const tooltip = mode === "mock"
    ? (status === "connected" ? "Demo mode (simulated data)" : "No connection")
    : (hostUrl || "No AHP host configured");

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger
          className={cn(
            "flex items-center gap-1.5 rounded-sm bg-transparent p-0 text-left outline-none",
            canRetry ? "cursor-pointer" : "cursor-default",
          )}
          onClick={canRetry ? () => connect(hostUrl) : undefined}
        >
          <div>
            <div className={cn("h-2 w-2 rounded-full", config.color)} />
          </div>
          <span className="text-xs text-muted-foreground">{config.label}</span>
        </TooltipTrigger>
        <TooltipContent className="max-w-64">
          <p>{tooltip}</p>
          {error && (
            <p className="mt-1 text-destructive">{error.message}</p>
          )}
          {canRetry && (
            <p className="mt-1 text-primary">Click to retry</p>
          )}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
