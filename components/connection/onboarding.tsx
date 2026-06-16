"use client";

import { useState } from "react";
import { Monitor, Play, Wifi } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useConnectionStore } from "@/lib/store/connection-store";

export function Onboarding() {
  const [remoteUrl, setRemoteUrl] = useState("");
  const { connect, useMockMode, status } = useConnectionStore();
  const isConnecting = status === "reconnecting";

  return (
    <div className="flex h-full items-center justify-center">
      <div className="w-full max-w-sm rounded-lg border border-border bg-card p-6">
        <h2 className="mb-1 text-lg font-semibold">Welcome to Planwerk</h2>
        <p className="mb-6 text-sm text-muted-foreground">
          Connect to an AHP host to manage your agent sessions.
        </p>

        <div className="space-y-3">
          <button
            onClick={() => connect("ws://localhost:3712")}
            disabled={isConnecting}
            className="w-full rounded-md border border-border p-3 text-left transition-colors hover:bg-muted/50 disabled:cursor-not-allowed disabled:opacity-50"
            type="button"
          >
            <div className="flex items-center gap-3">
              <Monitor className="h-4 w-4 text-primary" />
              <div>
                <div className="text-sm font-medium">VS Code (local)</div>
                <div className="text-xs text-muted-foreground">Auto-detect on localhost</div>
              </div>
            </div>
          </button>

          <div className="flex items-center gap-2">
            <Input
              placeholder="ws://remote-host:port"
              value={remoteUrl}
              onChange={(event) => setRemoteUrl(event.target.value)}
              className="h-9 text-sm"
            />
            <Button
              size="sm"
              variant="outline"
              onClick={() => connect(remoteUrl)}
              disabled={!remoteUrl || isConnecting}
            >
              <Wifi className="h-3.5 w-3.5" />
            </Button>
          </div>

          <button
            onClick={useMockMode}
            disabled={isConnecting}
            className="w-full rounded-md border border-dashed border-border p-3 text-left transition-colors hover:bg-muted/50 disabled:cursor-not-allowed disabled:opacity-50"
            type="button"
          >
            <div className="flex items-center gap-3">
              <Play className="h-4 w-4 text-muted-foreground" />
              <div>
                <div className="text-sm font-medium">Demo mode</div>
                <div className="text-xs text-muted-foreground">Explore with simulated data</div>
              </div>
            </div>
          </button>
        </div>
      </div>
    </div>
  );
}
