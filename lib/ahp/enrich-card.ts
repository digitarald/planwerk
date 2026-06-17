import "server-only";

import { KanbanCard } from "@/lib/types";
import {
  deriveGateStatus,
  getNextPhase,
  getPersistedCardPhase,
} from "@/lib/orchestrator/gate-engine";

import { mapSessionToCard } from "./map-session";
import { AHPSessionSummary } from "./types";
import type { ChangesetEnrichment } from "./changeset-enricher";

export function enrichSessionToCard(
  session: AHPSessionSummary,
  changesetData?: ChangesetEnrichment | null
): KanbanCard {
  const persistedPhase = getPersistedCardPhase(session.resource);
  const card = mapSessionToCard(session, persistedPhase, changesetData);

  const nextPhase = getNextPhase(card.phase);
  if (nextPhase) {
    card.gateStatus = deriveGateStatus(session.resource, card.phase, nextPhase);
  }

  return card;
}
