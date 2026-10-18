"use client";

import { useEffect, useMemo } from "react";

import { useBoardStore } from "@/lib/store/board-store";
import { useConnectionStore } from "@/lib/store/connection-store";
import { useCoordinatorPolicyStore } from "@/lib/store/coordinator-policy-store";
import { uiElapsed } from "@/lib/diagnostics/ui-performance-client";

/**
 * Board policy is global and always readable. A connected host only adds the
 * session IDs needed to resolve per-session overrides.
 */
export function useCoordinatorPolicyHydration() {
  const status = useConnectionStore((state) => state.status);
  const hostUrl = useConnectionStore((state) => state.hostUrl);
  const cards = useBoardStore((state) => state.cards);
  const hydrate = useCoordinatorPolicyStore((state) => state.hydrate);
  const cardIdKey = useMemo(
    () => cards.map((card) => card.id).sort().join("\u0000"),
    [cards],
  );

  useEffect(() => {
    const startedAt = performance.now();
    const hasSessionScope = status === "connected" && Boolean(hostUrl);
    void hydrate(
      hasSessionScope ? hostUrl : null,
      hasSessionScope && cardIdKey ? cardIdKey.split("\u0000") : [],
    ).then(() => uiElapsed("coordinator.hydrate", startedAt));
  }, [status, hostUrl, cardIdKey, hydrate]);
}
