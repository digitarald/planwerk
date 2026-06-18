import "server-only";

import { KanbanCard } from "@/lib/types";
import {
  deriveGateStatus,
  getNextPhase,
  getPersistedCardPhase,
} from "@/lib/orchestrator/gate-engine";
import { getCardRisk } from "@/lib/orchestrator/risk-store";

import { mapSessionToCard } from "./map-session";
import { AHPSessionSummary } from "./types";
import type { ChangesetEnrichment } from "./changeset-enricher";

export function enrichSessionToCard(
  session: AHPSessionSummary,
  changesetData?: ChangesetEnrichment | null
): KanbanCard {
  const persistedPhase = getPersistedCardPhase(session.resource);
  const persistedRisk = getCardRisk(session.resource)?.level;
  const card = mapSessionToCard(session, persistedPhase, changesetData, persistedRisk);

  const nextPhase = getNextPhase(card.phase);
  if (nextPhase) {
    card.gateStatus = deriveGateStatus(session.resource, card.phase, nextPhase, persistedRisk);
  }

  return card;
}
