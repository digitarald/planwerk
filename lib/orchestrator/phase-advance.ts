import "server-only";

import { setCardPhase } from "./gate-engine";
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
  config: CoherenceConfig = DEFAULT_COHERENCE_CONFIG
): { advanced: boolean; blockedBy: CoherenceRow[] } {
  const blockedBy = getShipBlockingConflicts(cardId, config);
  if (blockedBy.length > 0) {
    return { advanced: false, blockedBy };
  }
  setCardPhase(cardId, "ship");
  return { advanced: true, blockedBy: [] };
}
