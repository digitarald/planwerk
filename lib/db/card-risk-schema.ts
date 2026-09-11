import type Database from "better-sqlite3";

import { runSchemaMigration, tableColumns } from "./schema-migration.ts";

const CARD_RISK_TABLE = "card_risk";
const MIGRATING_CARD_RISK_TABLE = "card_risk_new";

export interface CardRiskMigrationOptions {
  afterCreateMigratingTable?: (
    db: Database.Database,
    tableName: string,
  ) => void;
}

function tableExists(db: Database.Database, tableName: string): boolean {
  return Boolean(db.prepare(`
    SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?
  `).get(tableName));
}

function createCardRiskTable(
  db: Database.Database,
  tableName: string,
): void {
  db.exec(`
    CREATE TABLE ${tableName} (
      card_id TEXT PRIMARY KEY,
      risk_level TEXT NOT NULL DEFAULT 'low',
      risk_factors TEXT NOT NULL DEFAULT '[]',
      assessed_at TEXT NOT NULL DEFAULT (datetime('now')),
      assessed_by TEXT NOT NULL DEFAULT 'copilot',
      risk_digest TEXT
    )
  `);
}

function foreignKeysEnabled(db: Database.Database): boolean {
  return db.pragma("foreign_keys", { simple: true }) === 1;
}

function restoreForeignKeys(
  db: Database.Database,
  enabled: boolean,
): void {
  db.pragma(`foreign_keys = ${enabled ? "ON" : "OFF"}`);
}

export function ensureCardRiskSchema(
  db: Database.Database,
  options: CardRiskMigrationOptions = {},
): void {
  let needsForeignKeyRebuild = false;
  runSchemaMigration(db, () => {
    const activeExists = tableExists(db, CARD_RISK_TABLE);
    const migratingExists = tableExists(db, MIGRATING_CARD_RISK_TABLE);
    if (!activeExists) {
      if (migratingExists) {
        db.exec(`
          ALTER TABLE ${MIGRATING_CARD_RISK_TABLE}
          RENAME TO ${CARD_RISK_TABLE}
        `);
      } else {
        createCardRiskTable(db, CARD_RISK_TABLE);
      }
    }

    const hasForeignKey = (
      db.prepare(`PRAGMA foreign_key_list(${CARD_RISK_TABLE})`).all() as Array<{
        table: string;
      }>
    ).length > 0;
    if (hasForeignKey) {
      needsForeignKeyRebuild = true;
      return;
    }

    const columns = tableColumns(db, CARD_RISK_TABLE);
    if (tableExists(db, MIGRATING_CARD_RISK_TABLE)) {
      db.exec(`DROP TABLE ${MIGRATING_CARD_RISK_TABLE}`);
    }
    if (!columns.has("risk_digest")) {
      db.exec(`
        ALTER TABLE ${CARD_RISK_TABLE}
        ADD COLUMN risk_digest TEXT
      `);
    }
  });

  if (!needsForeignKeyRebuild) return;

  const restoreForeignKeysTo = foreignKeysEnabled(db);
  try {
    db.pragma("foreign_keys = OFF");
    runSchemaMigration(db, () => {
      const hasForeignKey = (
        db.prepare(`PRAGMA foreign_key_list(${CARD_RISK_TABLE})`).all() as Array<{
          table: string;
        }>
      ).length > 0;
      const columns = tableColumns(db, CARD_RISK_TABLE);
      if (!hasForeignKey) {
        if (!columns.has("risk_digest")) {
          db.exec(`
            ALTER TABLE ${CARD_RISK_TABLE}
            ADD COLUMN risk_digest TEXT
          `);
        }
        return;
      }

      if (tableExists(db, MIGRATING_CARD_RISK_TABLE)) {
        db.exec(`DROP TABLE ${MIGRATING_CARD_RISK_TABLE}`);
      }
      createCardRiskTable(db, MIGRATING_CARD_RISK_TABLE);
      options.afterCreateMigratingTable?.(
        db,
        MIGRATING_CARD_RISK_TABLE,
      );
      db.exec(`
        INSERT INTO ${MIGRATING_CARD_RISK_TABLE} (
          card_id, risk_level, risk_factors, assessed_at, assessed_by,
          risk_digest
        )
        SELECT
          card_id, risk_level, risk_factors, assessed_at, assessed_by,
          ${columns.has("risk_digest") ? "risk_digest" : "NULL"}
        FROM ${CARD_RISK_TABLE}
      `);
      db.exec(`
        DROP TABLE ${CARD_RISK_TABLE};
        ALTER TABLE ${MIGRATING_CARD_RISK_TABLE}
        RENAME TO ${CARD_RISK_TABLE}
      `);
    });
  } finally {
    restoreForeignKeys(db, restoreForeignKeysTo);
  }
}
