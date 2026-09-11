import type Database from "better-sqlite3";

import { runSchemaMigration, tableColumns } from "./schema-migration.ts";

export function ensureSdkObservabilitySchema(db: Database.Database): void {
  runSchemaMigration(db, () => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS sdk_observability_events (
        sdk_event_id TEXT PRIMARY KEY,
        sdk_session_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        parent_event_id TEXT,
        event_timestamp TEXT NOT NULL,
        board_id TEXT,
        workspace_id TEXT,
        card_id TEXT,
        turn_id TEXT,
        tool_call_id TEXT,
        agent_id TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
        ingested_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);

    const columnNames = tableColumns(db, "sdk_observability_events");
    const additiveColumns: Array<[string, string]> = [
      ["board_id", "TEXT"],
      ["workspace_id", "TEXT"],
      ["card_id", "TEXT"],
      ["turn_id", "TEXT"],
      ["tool_call_id", "TEXT"],
      ["agent_id", "TEXT"],
      ["metadata_json", "TEXT NOT NULL DEFAULT '{}'"],
      ["ingested_at", "TEXT"],
    ];

    for (const [name, definition] of additiveColumns) {
      if (!columnNames.has(name)) {
        db.exec(
          `ALTER TABLE sdk_observability_events ADD COLUMN ${name} ${definition}`,
        );
        columnNames.add(name);
      }
    }

    db.exec(`
      UPDATE sdk_observability_events
      SET ingested_at = datetime('now')
      WHERE ingested_at IS NULL;

      CREATE INDEX IF NOT EXISTS idx_sdk_observability_session_time
        ON sdk_observability_events(sdk_session_id, event_timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_sdk_observability_card_time
        ON sdk_observability_events(card_id, event_timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_sdk_observability_workspace_time
        ON sdk_observability_events(workspace_id, event_timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_sdk_observability_turn
        ON sdk_observability_events(sdk_session_id, turn_id);
      CREATE INDEX IF NOT EXISTS idx_sdk_observability_tool
        ON sdk_observability_events(sdk_session_id, tool_call_id);
    `);
  });
}
