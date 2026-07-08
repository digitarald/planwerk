"use client";

import { useMemo, useState } from "react";
import { AlertTriangle, Ban, Monitor, RefreshCw, SearchX, ShieldAlert, Unplug, Wifi } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useConnectionStore, ConnectionErrorInfo } from "@/lib/store/connection-store";
import { usePersistentState } from "@/lib/hooks/use-persistent-state";
import type { ConnectionErrorCode } from "@/lib/ahp/connection-error";

const DEFAULT_HOST = process.env.NEXT_PUBLIC_AHP_DEFAULT_HOST ?? "ws://localhost:8082";

function isValidWsUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "ws:" || parsed.protocol === "wss:";
  } catch {
    return false;
  }
}

const errorIcons: Record<ConnectionErrorCode, typeof AlertTriangle> = {
  connection_refused: Unplug,
  auth_failed: ShieldAlert,
  protocol_error: AlertTriangle,
  disconnected: Unplug,
  unsupported_protocol_version: RefreshCw,
  permission_denied: Ban,
  session_not_found: SearchX,
  unknown: AlertTriangle,
};

function ConnectionError({ error }: { error: ConnectionErrorInfo }) {
  const Icon = errorIcons[error.code] ?? AlertTriangle;
  return (
    <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-xs">
      <div className="flex items-start gap-2">
        <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" />
        <div className="min-w-0 space-y-1">
          <p className="font-medium text-destructive">{error.message}</p>
          {error.hint && (
            <p className="text-muted-foreground">{error.hint}</p>
          )}
        </div>
      </div>
    </div>
  );
}

const CUSTOM_HOST_KEY = "planwerk-custom-host";

export function Onboarding() {
  // Saved host persists only on a successful connect; `draft` holds in-progress
  // edits so we don't write half-typed URLs to storage on every keystroke.
  const [savedUrl, setSavedUrl] = usePersistentState(CUSTOM_HOST_KEY, "");
  const [draft, setDraft] = useState<string | null>(null);
  const remoteUrl = draft ?? savedUrl;
  const setRemoteUrl = setDraft;
  const { connect, status, error } = useConnectionStore();

  const handleRemoteConnect = () => {
    setSavedUrl(remoteUrl);
    connect(remoteUrl);
  };
  const isConnecting = status === "reconnecting";
  const remoteUrlValid = useMemo(() => isValidWsUrl(remoteUrl), [remoteUrl]);
  const defaultHostLabel = useMemo(() => {
    try {
      const parsed = new URL(DEFAULT_HOST);
      const defaultPort = parsed.protocol === "wss:" ? "443" : "80";
      return `${parsed.hostname}:${parsed.port || defaultPort}`;
    } catch {
      return DEFAULT_HOST;
    }
  }, []);

  return (
    <div className="flex h-full items-center justify-center bg-gradient-to-b from-transparent via-transparent to-muted/20">
      <div className="w-full max-w-sm rounded-xl border border-border/60 bg-card p-6 shadow-elevation-md">
        <h2 className="mb-1 text-lg font-semibold">Welcome to Planwerk</h2>
        <p className="mb-6 text-sm text-muted-foreground">
          Connect to an AHP host to manage your agent sessions.
        </p>

        <div className="space-y-3">
          {isConnecting && (
            <div className="rounded-md border border-primary/30 bg-primary/5 p-3 text-center text-xs text-primary">
              Connecting...
            </div>
          )}

          {error && <ConnectionError error={error} />}

          <button
            onClick={() => connect(DEFAULT_HOST)}
            disabled={isConnecting}
            className="w-full rounded-md border border-border p-3 text-left transition-colors hover:bg-muted/50 disabled:cursor-not-allowed disabled:opacity-50"
            type="button"
          >
            <div className="flex items-center gap-3">
              <Monitor className="h-4 w-4 text-primary" />
              <div>
                <div className="text-sm font-medium">VS Code (local)</div>
                <div className="text-xs text-muted-foreground">Connect to {defaultHostLabel}</div>
              </div>
            </div>
          </button>

          <div className="flex items-center gap-2">
            <Input
              placeholder="ws://remote-host:8082"
              value={remoteUrl}
              onChange={(event) => setRemoteUrl(event.target.value)}
              className="h-9 text-sm"
            />
            <Button
              size="sm"
              variant="outline"
              onClick={handleRemoteConnect}
              disabled={!remoteUrlValid || isConnecting}
            >
              <Wifi className="h-3.5 w-3.5" />
            </Button>
          </div>
          {remoteUrl && !remoteUrlValid && (
            <p className="text-xs text-muted-foreground">URL must start with ws:// or wss://</p>
          )}
        </div>
      </div>
    </div>
  );
}
