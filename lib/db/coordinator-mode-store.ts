import type Database from "better-sqlite3";

import {
  DEFAULT_COORDINATOR_MODE,
  isCoordinatorMode,
  type CoordinatorMode,
} from "../orchestrator/coordinator-mode.ts";

export interface CoordinatorBoardMode {
  mode: CoordinatorMode;
  updatedAt: string;
}

export interface CoordinatorSessionMode extends CoordinatorBoardMode {
  hostUrl: string;
  cardId: string;
}

export interface EffectiveCoordinatorMode extends CoordinatorSessionMode {
  source: "board" | "session";
}

export interface CoordinatorModeAudit {
  id: number;
  scope: "board" | "session";
  hostUrl: string | null;
  cardId: string | null;
  previousMode: CoordinatorMode | null;
  mode: CoordinatorMode | null;
  operation: "set" | "remove";
  createdAt: string;
}

interface BoardModeRow {
  mode: unknown;
  updated_at: string;
}

interface SessionModeRow extends BoardModeRow {
  host_url: string;
  card_id: string;
}

function requireIdentifier(value: string, name: string): void {
  if (!value.trim()) throw new TypeError(`${name} must be non-empty`);
}

function requireMode(mode: unknown): asserts mode is CoordinatorMode {
  if (!isCoordinatorMode(mode)) {
    throw new TypeError("mode must be observe, verify, or coordinate");
  }
}

function validMode(value: unknown): CoordinatorMode | null {
  return isCoordinatorMode(value) ? value : null;
}

export class CoordinatorModeStore {
  private readonly db: Database.Database;
  private readonly now: () => string;

  constructor(
    db: Database.Database,
    now: () => string = () => new Date().toISOString(),
  ) {
    this.db = db;
    this.now = now;
  }

  getBoardDefault(): CoordinatorBoardMode {
    const row = this.db.prepare(`
      SELECT mode, updated_at
      FROM coordinator_board_mode
      WHERE singleton_key = 'board'
    `).get() as BoardModeRow | undefined;

    return {
      mode: validMode(row?.mode) ?? DEFAULT_COORDINATOR_MODE,
      updatedAt: row?.updated_at ?? this.now(),
    };
  }

  setBoardDefault(mode: CoordinatorMode): CoordinatorBoardMode {
    requireMode(mode);
    const updatedAt = this.now();
    const update = this.db.transaction(() => {
      const previousMode = this.getBoardDefault().mode;
      this.db.prepare(`
        INSERT INTO coordinator_board_mode (singleton_key, mode, updated_at)
        VALUES ('board', ?, ?)
        ON CONFLICT(singleton_key) DO UPDATE SET
          mode = excluded.mode,
          updated_at = excluded.updated_at
      `).run(mode, updatedAt);
      this.insertAudit({
        scope: "board",
        hostUrl: null,
        cardId: null,
        previousMode,
        mode,
        operation: "set",
        createdAt: updatedAt,
      });
    });
    update.immediate();
    return this.getBoardDefault();
  }

  getSessionOverride(
    hostUrl: string,
    cardId: string,
  ): CoordinatorSessionMode | null {
    requireIdentifier(hostUrl, "hostUrl");
    requireIdentifier(cardId, "cardId");
    const row = this.db.prepare(`
      SELECT host_url, card_id, mode, updated_at
      FROM coordinator_session_modes
      WHERE host_url = ? AND card_id = ?
    `).get(hostUrl, cardId) as SessionModeRow | undefined;
    return row ? this.mapSessionRow(row) : null;
  }

  listSessionOverrides(filters: {
    hostUrl?: string;
    cardIds?: readonly string[];
  } = {}): CoordinatorSessionMode[] {
    const clauses: string[] = [];
    const parameters: string[] = [];
    if (filters.hostUrl !== undefined) {
      requireIdentifier(filters.hostUrl, "hostUrl");
      clauses.push("host_url = ?");
      parameters.push(filters.hostUrl);
    }
    if (filters.cardIds !== undefined) {
      if (filters.cardIds.length === 0) return [];
      for (const cardId of filters.cardIds) {
        requireIdentifier(cardId, "cardId");
      }
      clauses.push(
        `card_id IN (${filters.cardIds.map(() => "?").join(", ")})`,
      );
      parameters.push(...filters.cardIds);
    }
    const rows = this.db.prepare(`
      SELECT host_url, card_id, mode, updated_at
      FROM coordinator_session_modes
      ${clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : ""}
      ORDER BY host_url, card_id
    `).all(...parameters) as SessionModeRow[];
    return rows.flatMap((row) => {
      const mapped = this.mapSessionRow(row);
      return mapped ? [mapped] : [];
    });
  }

  setSessionOverride(
    hostUrl: string,
    cardId: string,
    mode: CoordinatorMode | null,
  ): CoordinatorSessionMode | null {
    requireIdentifier(hostUrl, "hostUrl");
    requireIdentifier(cardId, "cardId");
    if (mode !== null) requireMode(mode);
    const updatedAt = this.now();
    const update = this.db.transaction(() => {
      const previousMode = this.getSessionOverride(hostUrl, cardId)?.mode ?? null;
      if (mode === null) {
        this.db.prepare(`
          DELETE FROM coordinator_session_modes
          WHERE host_url = ? AND card_id = ?
        `).run(hostUrl, cardId);
      } else {
        this.db.prepare(`
          INSERT INTO coordinator_session_modes (
            host_url, card_id, mode, updated_at
          ) VALUES (?, ?, ?, ?)
          ON CONFLICT(host_url, card_id) DO UPDATE SET
            mode = excluded.mode,
            updated_at = excluded.updated_at
        `).run(hostUrl, cardId, mode, updatedAt);
      }
      this.insertAudit({
        scope: "session",
        hostUrl,
        cardId,
        previousMode,
        mode,
        operation: mode === null ? "remove" : "set",
        createdAt: updatedAt,
      });
    });
    update.immediate();
    return this.getSessionOverride(hostUrl, cardId);
  }

  getEffectiveMode(hostUrl: string, cardId: string): EffectiveCoordinatorMode {
    const override = this.getSessionOverride(hostUrl, cardId);
    if (override) return { ...override, source: "session" };
    const board = this.getBoardDefault();
    return {
      hostUrl,
      cardId,
      mode: board.mode,
      updatedAt: board.updatedAt,
      source: "board",
    };
  }

  listAudit(): CoordinatorModeAudit[] {
    const rows = this.db.prepare(`
      SELECT id, scope, host_url, card_id, previous_mode, mode, operation,
        created_at
      FROM coordinator_mode_audit
      ORDER BY id
    `).all() as Array<{
      id: number;
      scope: "board" | "session";
      host_url: string | null;
      card_id: string | null;
      previous_mode: unknown;
      mode: unknown;
      operation: "set" | "remove";
      created_at: string;
    }>;
    return rows.map((row) => ({
      id: row.id,
      scope: row.scope,
      hostUrl: row.host_url,
      cardId: row.card_id,
      previousMode: validMode(row.previous_mode),
      mode: validMode(row.mode),
      operation: row.operation,
      createdAt: row.created_at,
    }));
  }

  private mapSessionRow(row: SessionModeRow): CoordinatorSessionMode | null {
    const mode = validMode(row.mode);
    return mode
      ? {
          hostUrl: row.host_url,
          cardId: row.card_id,
          mode,
          updatedAt: row.updated_at,
        }
      : null;
  }

  private insertAudit(
    audit: Omit<CoordinatorModeAudit, "id">,
  ): void {
    this.db.prepare(`
      INSERT INTO coordinator_mode_audit (
        scope, host_url, card_id, previous_mode, mode, operation, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      audit.scope,
      audit.hostUrl,
      audit.cardId,
      audit.previousMode,
      audit.mode,
      audit.operation,
      audit.createdAt,
    );
  }
}
