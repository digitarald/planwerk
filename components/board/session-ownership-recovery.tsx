"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { fetchOwnership, recoverOwnership, type OwnershipDiagnostic } from "@/lib/ahp/ownership-request";

export function SessionOwnershipRecovery({ sessionUri }: { sessionUri: string }) {
  const [record, setRecord] = useState<{ sessionUri: string; value: OwnershipDiagnostic } | null>(null);
  const [choice, setChoice] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [state, setState] = useState<"loading" | "ready" | "saving" | "saved" | "error">("loading");
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const active = useRef<AbortController | null>(null);
  const saving = useRef(false);
  useEffect(() => {
    const controller = new AbortController();
    active.current = controller;
    void fetchOwnership(sessionUri, controller.signal).then((value) => {
      if (controller.signal.aborted) return;
      setRecord({ sessionUri, value });
      setChoice("");
      setConfirmed(false);
      setState("ready");
    }).catch((failure: unknown) => {
      if (controller.signal.aborted) return;
      setError(failure instanceof Error ? failure.message : "Could not load ownership details");
      setState("error");
    });
    return () => {
      controller.abort();
      if (active.current === controller) active.current = null;
    };
  }, [sessionUri, reload]);
  const value = record?.sessionUri === sessionUri ? record.value : undefined;
  const save = async () => {
    const controller = active.current;
    if (!value?.quarantined || !choice || !confirmed || !controller || state !== "ready" || saving.current) return;
    saving.current = true;
    setState("saving");
    setError("");
    try {
      const ownership = await recoverOwnership(sessionUri, choice, value.revision, controller.signal);
      if (controller.signal.aborted || active.current !== controller) return;
      setRecord({ sessionUri, value: ownership });
      setState("saved");
    } catch (failure) {
      if (controller.signal.aborted || active.current !== controller) return;
      setError(failure instanceof Error ? failure.message : "Ownership recovery failed");
      setState("error");
    } finally {
      saving.current = false;
    }
  };
  return (
    <div className="space-y-3 border-t border-border/60 pt-3">
      {state === "loading" && <p role="status">Loading the recorded hosts…</p>}
      {value?.quarantined && (
        <>
          <fieldset className="space-y-2" disabled={state !== "ready"}>
            <legend className="mb-2 font-medium text-foreground">Manage this session from</legend>
            {value.hosts.map((host) => (
              <label key={host.hostId} className="flex min-w-0 items-start gap-2">
                <input
                  type="radio" name={`owner-${sessionUri}`} value={host.hostId}
                  checked={choice === host.hostId}
                  className="mt-1 shrink-0 accent-primary"
                  onChange={() => { setChoice(host.hostId); setConfirmed(false); }}
                />
                <span className="min-w-0 break-all text-foreground">
                  {host.label}
                  <span className="ml-1 text-muted-foreground">{host.hostId === value.owner.hostId ? "(recorded owner)" : "(also claims this session)"}</span>
                </span>
              </label>
            ))}
            <label className="flex items-start gap-2 pt-1">
              <input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} className="mt-1 shrink-0 accent-primary" />
              <span>Keep phase and history, but invalidate old evidence, risk assessments and gate/review results. Record this host choice.</span>
            </label>
          </fieldset>
          <Button size="sm" disabled={!choice || !confirmed || state !== "ready"} aria-busy={state === "saving"} onClick={save}>
            {state === "saving" ? "Resolving ownership" : "Confirm host"}
          </Button>
        </>
      )}
      {value && !value.quarantined && (
        <p role="status">Ownership resolved to <span className="break-all">{value.owner.label}</span>. Connect to that host and refresh evidence before running gates.</p>
      )}
      {state === "error" && (
        <div className="space-y-2">
          <p role="alert" className="text-destructive">{error}</p>
          <Button variant="ghost" size="sm" onClick={() => { setState("loading"); setError(""); setReload((count) => count + 1); }}>Reload choices</Button>
        </div>
      )}
    </div>
  );
}
