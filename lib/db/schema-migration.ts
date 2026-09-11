import type Database from "better-sqlite3";

export function runSchemaMigration(
  db: Database.Database,
  migrate: () => void,
): void {
  if (db.inTransaction) {
    migrate();
    return;
  }
  db.transaction(migrate).immediate();
}

export function tableColumns(
  db: Database.Database,
  tableName: string,
): Set<string> {
  return new Set(
    (db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{
      name: string;
    }>).map(({ name }) => name),
  );
}
