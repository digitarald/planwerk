"use client";

import { useEffect, useState } from "react";

import type { GateRunView } from "@/lib/types";

/** Fetch the real GateRun records for a card from the gate engine so the UI
 *  can explain *why* a gate passed/failed and how fresh the verdict is.
 *  Only fetches while `enabled` (e.g. the detail modal is open). */
export function useGateRuns(cardId: string | undefined, enabled: boolean): { runs: GateRunView[] } {
  const [runs, setRuns] = useState<GateRunView[]>([]);

  useEffect(() => {
    if (!enabled || !cardId) return;

    let cancelled = false;

    fetch(`/api/gates/status?cardId=${encodeURIComponent(cardId)}`)
      .then((res) => (res.ok ? res.json() : { runs: [] }))
      .then((data: { runs?: GateRunView[] }) => {
        if (!cancelled) setRuns(data.runs ?? []);
      })
      .catch(() => {
        if (!cancelled) setRuns([]);
      });

    return () => {
      cancelled = true;
    };
  }, [cardId, enabled]);

  return { runs };
}
