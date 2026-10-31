import type Database from "better-sqlite3";

import { AHPStatus, type AHPSessionSummary } from "../ahp/types.ts";
import {
  getInboxSessionItems,
  observeInboxSource,
  resolveInboxSource,
  type InboxMutation,
} from "../db/inbox-store.ts";

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
    for (const item of getInboxSessionItems(db, hostUrl, options.cardId)) {
      if (!item.cardId || options.ownsSession?.(item.cardId) === false) continue;
      const source = sources.get(item.cardId);
      const status = source?.session.status ?? 0;
      const needsInput = (status & AHPStatus.InputNeeded) === AHPStatus.InputNeeded;
      const archived = (status & AHPStatus.IsArchived) !== 0;
      const obsolete = !source || !source.enabled
        || (archived && ["pending-input", "runtime-error", "review-ready", "ship-ready"].includes(item.kind))
        || (item.kind === "pending-input" && !needsInput)
        || (item.kind === "runtime-error" && !(status & AHPStatus.Error));
      if (source) {
        mutations.push(observeInboxSource(db, item, {
          sessionTitle: source.session.title,
          projectName: source.session.project?.name,
          workspacePath: source.session.project?.path,
        }, item.kind === "pending-input" && needsInput ? undefined : now));
      }
      if (obsolete) {
        const mutation = resolveInboxSource(db, item.sourceKey, now);
        if (mutation) mutations.push(mutation);
      }
    }
    return mutations;
  }).immediate();
}
