export interface MigrationDefinition {
  id: string;
  sql?: string;
  apply?: (db: import("./db.js").Database) => void;
}

function hasTableColumn(
  db: import("./db.js").Database,
  tableName: string,
  columnName: string,
): boolean {
  const escapedTableName = tableName.replaceAll("'", "''");
  const row = db
    .prepare<{ columnName: string }, { name: string }>(
      `SELECT name
       FROM pragma_table_info('${escapedTableName}')
       WHERE name = @columnName`,
    )
    .get({ columnName });

  return row !== undefined;
}

export const STORE_MIGRATIONS: readonly MigrationDefinition[] = [
  {
    id: "001_initial_store_schema",
    sql: `
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        backend TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'created',
        display_name TEXT NOT NULL,
        cwd TEXT NOT NULL,
        model TEXT NOT NULL DEFAULT '',
        system_prompt TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        backend_checkpoint_json TEXT,
        runtime_config_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_error_json TEXT,
        context_usage_json TEXT,
        archived INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS operations (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        type TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        result_json TEXT,
        error_json TEXT,
        created_at TEXT NOT NULL,
        completed_at TEXT
      );
    `,
  },
  {
    id: "002_message_store",
    sql: `
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        source TEXT NOT NULL,
        source_msg_id TEXT,
        kind TEXT NOT NULL,
        role TEXT NOT NULL,
        content_json TEXT NOT NULL,
        order_key TEXT NOT NULL,
        created_at TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        UNIQUE(session_id, order_key)
      );

      CREATE INDEX IF NOT EXISTS idx_messages_session_order
        ON messages(session_id, order_key);

      CREATE INDEX IF NOT EXISTS idx_messages_source_msg
        ON messages(session_id, source_msg_id);
    `,
  },
  {
    id: "004_session_context_usage",
    apply(db) {
      if (hasTableColumn(db, "sessions", "context_usage_json")) {
        return;
      }

      db.exec(`
        ALTER TABLE sessions
        ADD COLUMN context_usage_json TEXT;
      `);
    },
  },
  {
    id: "005_session_archived",
    apply(db) {
      if (hasTableColumn(db, "sessions", "archived")) {
        return;
      }

      db.exec(`
        ALTER TABLE sessions
        ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;
      `);
    },
  },
  {
    id: "006_fold_backend_state_into_session_metadata",
    sql: `
      CREATE TABLE IF NOT EXISTS session_backend_state (
        session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
        state_json TEXT NOT NULL
      );

      UPDATE sessions
      SET metadata_json = json_set(
        CASE
          WHEN json_valid(metadata_json) AND json_type(metadata_json) = 'object' THEN metadata_json
          ELSE '{}'
        END,
        '$._backendState',
        json((
          SELECT state_json
          FROM session_backend_state
          WHERE session_id = sessions.id
        ))
      )
      WHERE EXISTS (
        SELECT 1
        FROM session_backend_state
        WHERE session_id = sessions.id
      );

      DROP TABLE IF EXISTS session_backend_state;
    `,
  },
];
