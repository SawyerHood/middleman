export interface MigrationDefinition {
  id: string;
  sql: string;
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
        last_error_json TEXT
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
    `
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
    `
  },
  {
    id: "003_session_backend_state",
    sql: `
      CREATE TABLE IF NOT EXISTS session_backend_state (
        session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
        backend TEXT NOT NULL,
        state_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `
  },
  {
    id: "004_session_context_usage",
    sql: `
      ALTER TABLE sessions
      ADD COLUMN context_usage_json TEXT;
    `
  },
  {
    id: "005_session_archived",
    sql: `
      ALTER TABLE sessions
      ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;
    `
  }
];
