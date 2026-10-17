import "server-only";

import { setCardPhase } from "./gate-engine";
import { getDb } from "@/lib/db/schema";
import { isSessionOwnedByHost } from "@/lib/db/session-ownership";
import { resolveAuthoritativeGateRevision } from "./gate-revision";
import {
  getShipBlockingConflicts,
  type CoherenceConfig,
  type CoherenceRow,
  DEFAULT_COHERENCE_CONFIG,
} from "./coherence-engine";

/**
 * The single choke point for `review → ship` advancement. Every path that moves a
 * card to Ship (heartbeat auto-advance, manual gate API, DnD advance) MUST go
 * through here so coherence blocking cannot be bypassed. Never call
 * `setCardPhase(id, "ship")` directly for a review→ship transition.
 *
 * Blocking is computed live from current risk + config (pair-level), so a
 * provisional high-risk conflict blocks even before a reviewer verdict lands.
 */
export function advanceReviewToShip(
  cardId: string,
  config: CoherenceConfig = DEFAULT_COHERENCE_CONFIG,
  hostUrl: string,
): { advanced: boolean; blockedBy: CoherenceRow[]; reason?: string } {
  const db = getDb();
  return db.transaction(() => {
    if (!hostUrl?.trim() || !isSessionOwnedByHost(db, cardId, hostUrl) ||
        !resolveAuthoritativeGateRevision(db, cardId, "review", hostUrl).ok) {
      return { advanced: false, blockedBy: [], reason: "Current host-owned evidence is required to ship." };
    }
    const blockedBy = getShipBlockingConflicts(cardId, config, hostUrl);
    if (blockedBy.length > 0) {
      return { advanced: false, blockedBy };
    }
    setCardPhase(cardId, "ship");
    return { advanced: true, blockedBy: [] };
  }).immediate();
}
