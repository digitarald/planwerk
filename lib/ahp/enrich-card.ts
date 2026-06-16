import "server-only";

import { KanbanCard } from "@/lib/types";
import {
  deriveGateStatus,
  getNextPhase,
  getPersistedCardPhase,
} from "@/lib/orchestrator/gate-engine";

import { mapSessionToCard } from "./map-session";
import { AHPSessionSummary } from "./types";

export function enrichSessionToCard(session: AHPSessionSummary): KanbanCard {
  const persistedPhase = getPersistedCardPhase(session.resource);
  const card = mapSessionToCard(session, persistedPhase);

  const nextPhase = getNextPhase(card.phase);
  if (nextPhase) {
    card.gateStatus = deriveGateStatus(session.resource, card.phase, nextPhase);
  }

  return card;
}
