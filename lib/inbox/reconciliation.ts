import type Database from "better-sqlite3";

import { AHPStatus, type AHPSessionSummary } from "../ahp/types.ts";
import {
  getSessionLinkedInboxItems,
  updateInboxBriefing,
  resolveInboxSource,
  type InboxMutation,
} from "../db/inbox-store.ts";
import { observeInboxBriefing, sessionIdentity } from "./observation.ts";
import { sessionRetirementReason, type InboxSessionState } from "./lifecycle.ts";

export interface InboxCatalogEntry {
  session: AHPSessionSummary;
  enabled: boolean;
}

export function reconcileInboxCatalog(
  db: Database.Database,
  hostUrl: string,
  catalog: readonly InboxCatalogEntry[],
  options: {
    complete: boolean;
    cardId?: string;
    now?: string;
    ownsSession?: (cardId: string) => boolean;
  },
): InboxMutation[] {
  if (!options.complete) return [];
  const now = options.now ?? new Date().toISOString();
  const sources = new Map(catalog.map((entry) => [entry.session.resource, entry]));
  return db.transaction(() => {
    const mutations: InboxMutation[] = [];
    for (const item of getSessionLinkedInboxItems(db, { hostUrl, cardId: options.cardId })) {
      if (!item.cardId || options.ownsSession?.(item.cardId) === false) continue;
      const source = sources.get(item.cardId);
      const status = source?.session.status ?? 0;
      const state: InboxSessionState = !source ? { type: "missing" }
        : !source.enabled ? { type: "disabled" }
        : status & AHPStatus.IsArchived ? { type: "archived" }
        : {
            type: "active",
            needsInput: (status & AHPStatus.InputNeeded) === AHPStatus.InputNeeded,
            hasError: (status & AHPStatus.Error) !== 0,
          };
      if (source) {
        mutations.push(updateInboxBriefing(db, item, observeInboxBriefing(
          item, sessionIdentity(source.session), { type: "catalog", observedAt: now },
        )));
      }
      if (sessionRetirementReason(item.kind, state)) {
        const mutation = resolveInboxSource(db, item.sourceKey, now);
        if (mutation) mutations.push(mutation);
      }
    }
    return mutations;
  }).immediate();
}
