"use client";

import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { Plus, X, Loader2, FolderGit2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useConnectionStore } from "@/lib/store/connection-store";
import {
  useBoardStore,
  selectWorkspaces,
  UNASSIGNED_WORKSPACE,
} from "@/lib/store/board-store";
import { usePersistentState } from "@/lib/hooks/use-persistent-state";
import type { ConfigPropertySchema, ModelSelection, SessionConfigPropertySchema } from "@microsoft/agent-host-protocol";
import { creationSummary, isCreationControl, type CreationConfiguration } from "@/lib/ahp/creation-config";
import type { TaskCreationEvent } from "@/lib/ahp/task-creation";

const LAST_WORKSPACE_KEY = "planwerk-last-workspace";

interface SessionCreatorProps {
  compact?: boolean;
}

export function SessionCreator({ compact = false }: SessionCreatorProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [task, setTask] = useState("");
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selection, setSelection] = useState<{ provider?: string; config?: Record<string, unknown>; model?: ModelSelection }>({});
  const [resolved, setResolved] = useState<{ key: string; configuration: CreationConfiguration } | null>(null);
  const [configurationError, setConfigurationError] = useState<{ key: string; message: string } | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [completion, setCompletion] = useState<{ property: string; query: string } | undefined>();
  const [progress, setProgress] = useState("Starting…");
  const [recovery, setRecovery] = useState<string | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const submitting = useRef(false);
  const hostUrl = useConnectionStore((state) => state.hostUrl);
  const connected = useConnectionStore((state) => state.status === "connected");

  const workspaces = useBoardStore(selectWorkspaces);
  // Known, assignable workspaces (a real path — not the "unassigned" bucket).
  const options = useMemo(
    () => workspaces.filter((w) => w.path && w.path !== UNASSIGNED_WORKSPACE),
    [workspaces],
  );

  const [workspace, setWorkspace] = usePersistentState(
    LAST_WORKSPACE_KEY,
    options[0]?.path ?? "",
  );
  // Fall back to the first known workspace if the remembered one is gone.
  const selectedPath =
    options.find((w) => w.path === workspace)?.path ?? options[0]?.path ?? "";
  const resolutionKey = JSON.stringify({ hostUrl, selectedPath, selection, completion, refresh });
  const configurationCurrent = resolved?.key === resolutionKey;
  const configuration = resolved?.configuration ?? null;
  const configError = configurationError?.key === resolutionKey ? configurationError.message : null;

  useEffect(() => {
    if (!isOpen || !hostUrl || !connected || !selectedPath || isCreating || uncertain) return;
    const controller = new AbortController();
    const timer = setTimeout(() => { void fetch("/api/ahp/sessions/configuration", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({ hostUrl, workingDirectory: selectedPath, ...selection, completion }),
    }).then(async (response) => {
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Task options unavailable");
      if (!controller.signal.aborted) {
        setResolved({ key: resolutionKey, configuration: data });
        setConfigurationError(null);
      }
    }).catch((err) => {
      if (!controller.signal.aborted) setConfigurationError({ key: resolutionKey, message: err instanceof Error ? err.message : "Task options unavailable" });
    }); }, 150);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [isOpen, hostUrl, connected, selectedPath, selection, completion, resolutionKey, isCreating, uncertain]);

  const reset = () => {
    if (submitting.current) return;
    setTask("");
    setError(null);
    setRecovery(null);
    setUncertain(false);
    setCompletion(undefined);
    setIsOpen(false);
  };

  const handleCreate = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = task.trim();
    if (!trimmed || submitting.current || uncertain || !configurationCurrent || !configuration || configuration.problems.length) return;

    const { hostUrl, status: connStatus } = useConnectionStore.getState();
    if (connStatus !== "connected" || !hostUrl) {
      setError("Not connected to an AHP host");
      return;
    }
    if (!selectedPath) {
      setError("Pick a workspace for this task");
      return;
    }

    setIsCreating(true);
    submitting.current = true;
    setError(null);
    setProgress("Connecting…");
    let dispatched = false;
    let candidate: string | undefined;
    try {
      const requestId = crypto.randomUUID();
      candidate = `${configuration.provider}:/${requestId}`;
      dispatched = true;
      const response = await fetch("/api/ahp/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/x-ndjson" },
        body: JSON.stringify({
          hostUrl,
          prompt: trimmed,
          workingDirectory: selectedPath,
          requestId,
          provider: configuration.provider,
          config: configuration.values,
          model: configuration.model,
          revision: configuration.revision,
        }),
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        setError(data.error || "Failed to create task");
        setRefresh((value) => value + 1);
        return;
      }
      if (!response.body) throw new Error("Startup response was interrupted.");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let result: Extract<TaskCreationEvent, { type: "result" }> | undefined;
      try {
        while (true) {
          const { done, value } = await reader.read();
          buffer += decoder.decode(value, { stream: !done });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.trim()) continue;
            const event = JSON.parse(line) as TaskCreationEvent;
            if (event.type === "stage") setProgress({
              connecting: "Connecting…", validating: "Checking task options…",
              creating: "Creating session…", sending: "Session created · sending task…",
            }[event.stage]);
            if (event.type === "progress") {
              const { progress: amount, total, message } = event.progress;
              const percent = typeof total === "number" && Number.isFinite(total) && total > 0 && amount <= total
                ? ` · ${Math.floor(amount / total * 100)}%` : "";
              setProgress(`Session setup${message ? ` · ${message}` : "…"}${percent}`);
            }
            if (event.type === "result") result = event;
          }
          if (done) break;
        }
      } finally { reader.releaseLock(); }
      if (!result) throw new Error("Startup response was interrupted. Check the board before starting another task.");
      if (result.outcome === "started" || result.outcome === "queued") {
        submitting.current = false;
        reset();
      } else {
        setError(result.error ?? "Task setup failed");
        setRecovery(result.resource ?? null);
        setUncertain(!!result.resource || result.outcome === "creation-uncertain");
        if (result.outcome === "invalid") setRefresh((value) => value + 1);
      }
    } catch (err) {
      setError(`${err instanceof Error ? err.message : "Network error"}${dispatched ? " The session may exist. Check the board; creation will not be retried." : ""}`);
      setUncertain(dispatched);
      if (dispatched) setRecovery(candidate ?? null);
    } finally {
      submitting.current = false;
      setIsCreating(false);
    }
  };

  const agent = configuration?.providers.find((provider) => provider.provider === configuration.provider);
  const model = agent?.models.find((entry) => entry.id === configuration?.model?.id);
  const properties = Object.entries(configuration?.schema.properties ?? {}).filter(([, property]) => isCreationControl(property));
  const mainKeys = new Set(properties.filter(([key]) => /^(autoApprove|isolation|target)$|permissions?(Policy|Preset)$/i.test(key)).map(([key]) => key));
  const disabled = isCreating || uncertain;
  const controlsDisabled = disabled || !connected || !configurationCurrent;
  const updateConfig = (key: string, value: unknown) => {
    setCompletion(undefined);
    setSelection({ provider: configuration?.provider, config: { ...configuration?.values, [key]: value }, model: configuration?.model });
  };
  const control = (key: string, property: ConfigPropertySchema, value: unknown, update: (value: unknown) => void, choices?: { value: string; label: string }[]) => {
    const entries = choices?.map((choice) => ({ value: choice.value, label: choice.label })) ??
      property.enum?.map((entry, index) => ({ value: entry, label: property.enumLabels?.[index] ?? String(entry) }));
    return (
      <div key={key} data-creation-field={key} className="space-y-1">
      <label className="flex min-w-0 flex-wrap items-center gap-1.5 text-[11px]" title={property.description}>
        <span className="max-w-full shrink-0 break-words text-muted-foreground">{property.title}</span>
        {entries ? (
          <select
            aria-label={property.title}
            value={value === undefined ? "" : JSON.stringify(value)}
            onChange={(event) => { if (event.target.value) update(JSON.parse(event.target.value)); }}
            disabled={controlsDisabled || property.readOnly}
            className="min-w-[min(8rem,100%)] flex-1 rounded-md border border-input bg-card px-1.5 py-1 text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {value === undefined && <option value="">Choose…</option>}
            {entries.map((entry) => <option key={JSON.stringify(entry.value)} value={JSON.stringify(entry.value)}>{entry.label}</option>)}
          </select>
        ) : property.type === "boolean" ? (
          <input type="checkbox" aria-label={property.title} checked={value === true} onChange={(event) => update(event.target.checked)} disabled={controlsDisabled || property.readOnly} className="accent-primary" />
        ) : (
          <input aria-label={property.title} type={property.type === "number" ? "number" : "text"} value={value === undefined ? "" : String(value)}
            onChange={(event) => update(property.type === "number" ? Number(event.target.value) : event.target.value)}
            disabled={controlsDisabled || property.readOnly} className="min-w-[min(8rem,100%)] flex-1 rounded-md border border-input bg-card px-1.5 py-1 outline-none focus-visible:ring-2 focus-visible:ring-ring" />
        )}
      </label>
      {(property as SessionConfigPropertySchema).enumDynamic && <input
        aria-label={`Search ${property.title}`} placeholder={`Search ${property.title.toLowerCase()}…`}
        value={completion?.property === key ? completion.query : ""} disabled={disabled || !connected}
        onChange={(event) => setCompletion({ property: key, query: event.target.value })}
        className="w-full rounded-md border border-input bg-card px-1.5 py-1 text-[11px] outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />}
      </div>
    );
  };

  if (!isOpen) {
    return (
      <button
        type="button"
        onClick={() => setIsOpen(true)}
        className="flex w-full items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
        aria-label={compact ? "New task" : undefined}
        title={compact ? "New task" : undefined}
      >
        <Plus className="h-3.5 w-3.5" />
        {!compact && <span>New task</span>}
      </button>
    );
  }

  return (
    <form
      onSubmit={handleCreate}
      className={`space-y-2 rounded-lg border border-border/70 bg-card p-2 shadow-elevation-xs ${
        compact ? "absolute bottom-0 left-full z-dropdown ml-2 w-72" : ""
      }`}
    >
      <Textarea
        value={task}
        aria-label="Task description"
        disabled={disabled}
        onChange={(event) => setTask(event.target.value)}
        placeholder="Describe the task…"
        rows={3}
        autoFocus
        className="min-h-[60px] resize-none text-[13px] leading-relaxed"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            reset();
          } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            void handleCreate(event);
          }
        }}
      />

      {/* Workspace picker */}
      <label className="flex items-center gap-1.5 rounded-md border border-input bg-transparent px-2 py-1 text-[11px] focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50">
        <FolderGit2 className="h-3 w-3 shrink-0 text-muted-foreground" />
        {options.length > 0 ? (
          <select
            value={selectedPath}
            disabled={disabled}
            onChange={(event) => { setWorkspace(event.target.value); setCompletion(undefined); setSelection({ provider: configuration?.provider }); }}
            className="min-w-0 flex-1 cursor-pointer bg-transparent text-foreground outline-none"
            aria-label="Workspace"
          >
            {options.map((w) => (
              <option key={w.path} value={w.path}>
                {w.name}
              </option>
            ))}
          </select>
        ) : (
          <span className="flex-1 text-muted-foreground">
            No workspaces available yet
          </span>
        )}
      </label>

      {configuration && (
        <>
          {configuration.providers.length > 1 && (
            <label className="flex items-center gap-1.5 text-[11px]">
              <span className="text-muted-foreground">Provider</span>
              <select aria-label="Agent provider" value={configuration.provider} disabled={controlsDisabled}
                onChange={(event) => { setCompletion(undefined); setSelection({ provider: event.target.value }); }}
                className="min-w-0 flex-1 rounded-md border border-input bg-card px-1.5 py-1 outline-none focus-visible:ring-2 focus-visible:ring-ring">
                {configuration.providers.map((provider) => <option key={provider.provider} value={provider.provider}>{provider.displayName}</option>)}
              </select>
            </label>
          )}
          {agent && agent.models.length > 0 && (
            <label className="flex items-center gap-1.5 text-[11px]">
              <span className="text-muted-foreground">Model</span>
              <select aria-label="Model" value={configuration.model?.id ?? ""} disabled={controlsDisabled}
                onChange={(event) => setSelection({ provider: configuration.provider, config: configuration.values, model: event.target.value ? { id: event.target.value } : undefined })}
                className="min-w-0 flex-1 rounded-md border border-input bg-card px-1.5 py-1 outline-none focus-visible:ring-2 focus-visible:ring-ring">
                <option value="">Host default</option>
                {agent.models.map((model) => <option key={model.id} value={model.id} disabled={model.policyState === "disabled"}>{model.name}{model.policyState === "disabled" ? " (disabled)" : ""}</option>)}
              </select>
            </label>
          )}
          {properties.filter(([key]) => mainKeys.has(key)).map(([key, property]) => control(key, property, configuration.values[key], (value) => updateConfig(key, value), configuration.completions[key]))}
          {(properties.some(([key]) => !mainKeys.has(key)) || model?.configSchema) && (
            <details className="text-[11px]">
              <summary className="cursor-pointer rounded-sm text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring">Task options</summary>
              <div className="mt-2 space-y-2">
                {properties.filter(([key]) => !mainKeys.has(key)).map(([key, property]) => control(key, property, configuration.values[key], (value) => updateConfig(key, value), configuration.completions[key]))}
                {Object.entries(model?.configSchema?.properties ?? {}).filter(([, property]) => isCreationControl(property)).map(([key, property]) =>
                  control(`model-${key}`, property, configuration.model?.config?.[key], (value) => setSelection({
                    provider: configuration.provider, config: configuration.values,
                    model: { id: model!.id, config: { ...configuration.model?.config, [key]: value as string | number | boolean } },
                  })))}
              </div>
            </details>
          )}
        </>
      )}

      <p className="px-0.5 text-[10px] leading-4 text-muted-foreground" aria-live="polite">
        {!connected ? "Connect to an AHP host to configure this task" : configError ? "Task options unavailable" : configurationCurrent && configuration ? creationSummary(configuration) : "Resolving task options…"}
      </p>
      {configuration?.provider !== "copilotcli" && configuration && <p className="text-[10px] text-muted-foreground">Uses {agent?.displayName} settings, not Copilot’s Plan/bypass defaults.</p>}
      {configuration?.problems.map((problem) => <p key={problem} className="text-[10px] text-destructive">{problem}</p>)}
      {configError && <p role="alert" className="text-[10px] text-destructive">{configError}</p>}
      {(configError || error && !uncertain) && <button type="button" disabled={isCreating} onClick={() => { setCompletion(undefined); setSelection({ provider: configuration?.provider }); setRefresh((value) => value + 1); setError(null); }} className="text-[11px] underline underline-offset-2">Refresh task options</button>}

      <div className="flex gap-1">
        <Button
          type="submit"
          size="sm"
          className="h-6 flex-1 gap-1 px-2 text-[10px]"
          disabled={!task.trim() || !selectedPath || disabled || !connected || !configurationCurrent || !configuration || !!configuration.problems.length}
        >
          {isCreating ? (
            <>
              <Loader2 className="h-3 w-3 animate-spin" />
              <span>Creating task…</span>
            </>
          ) : (
            "Create task"
          )}
        </Button>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-6 px-2 text-[10px]"
                onClick={reset}
                disabled={isCreating}
                aria-label={uncertain ? "Close task setup" : "Cancel new task"}
              />
            }
          >
            <X className="h-3 w-3" />
          </TooltipTrigger>
          <TooltipContent>{uncertain ? "Close task setup" : "Cancel new task"}</TooltipContent>
        </Tooltip>
      </div>

      {isCreating && <p role="status" className="break-words text-[10px] text-muted-foreground">{progress}</p>}
      {error && <p role="alert" className="text-[10px] text-destructive">{error}</p>}
      {recovery && <label className="block text-[10px] text-muted-foreground">Session to recover
        <input aria-label="Created or possibly created session URI" readOnly value={recovery} onFocus={(event) => event.target.select()} className="mt-1 w-full rounded border border-input bg-card px-1 py-1 text-foreground" />
      </label>}
    </form>
  );
}
