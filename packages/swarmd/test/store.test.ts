import { afterEach, describe, expect, it } from "vitest";

import {
  OperationRepo,
  SessionRepo,
  createDatabase,
  runMigrations,
  type Database,
  type OperationRecord,
  type SessionRecord,
} from "../src/core/store/index.js";

describe("SQLite store repositories", () => {
  const openDatabases: Database[] = [];

  afterEach(() => {
    while (openDatabases.length > 0) {
      openDatabases.pop()?.close();
    }
  });

  it("persists sessions and operations in memory", () => {
    const db = createDatabase(":memory:");
    openDatabases.push(db);
    runMigrations(db);

    const sessionRepo = new SessionRepo(db);
    const operationRepo = new OperationRepo(db);

    const session: SessionRecord = {
      id: "session-1",
      backend: "codex",
      status: "created",
      displayName: "Primary Session",
      cwd: "/tmp/swarmd",
      model: "gpt-5",
      systemPrompt: "You are swarmd.",
      backendCheckpoint: { backend: "codex", threadId: "backend-thread-1" },
      createdAt: "2026-03-13T00:00:00.000Z",
      updatedAt: "2026-03-13T00:00:00.000Z",
      lastError: null,
      contextUsage: null,
    };

    sessionRepo.create(session);
    expect(sessionRepo.getById(session.id)).toEqual(session);

    sessionRepo.updateCheckpoint(session.id, {
      backend: "claude",
      sessionId: "claude-session-1",
      resumeAtMessageId: "msg_123",
    });
    expect(sessionRepo.getById(session.id)?.backendCheckpoint).toEqual({
      backend: "claude",
      sessionId: "claude-session-1",
      resumeAtMessageId: "msg_123",
    });

    const operation: OperationRecord = {
      id: "op-1",
      sessionId: session.id,
      type: "sync",
      status: "pending",
      resultJson: null,
      errorJson: null,
      createdAt: "2026-03-13T00:04:00.000Z",
      completedAt: null,
    };

    operationRepo.create(operation);
    operationRepo.complete(operation.id, { ok: true });

    const storedOperation = operationRepo.getById(operation.id);
    expect(storedOperation).not.toBeNull();
    expect(storedOperation?.status).toBe("completed");
    expect(storedOperation?.resultJson).toBe(JSON.stringify({ ok: true }));
    expect(storedOperation?.errorJson).toBeNull();
    expect(storedOperation?.completedAt).not.toBeNull();
  });

  it("stores backend state inside session metadata without exposing generic session metadata", () => {
    const db = createDatabase(":memory:");
    openDatabases.push(db);
    runMigrations(db);

    const sessionRepo = new SessionRepo(db);

    const session: SessionRecord = {
      id: "session-with-backend-state",
      backend: "claude",
      status: "created",
      displayName: "Claude Session",
      cwd: "/tmp/swarmd",
      model: "claude-sonnet",
      systemPrompt: undefined,
      backendCheckpoint: null,
      createdAt: "2026-03-13T00:00:00.000Z",
      updatedAt: "2026-03-13T00:00:00.000Z",
      lastError: null,
      contextUsage: null,
    };

    sessionRepo.create(session);
    sessionRepo.updateBackendState(session.id, { sessionId: "claude-session-1" });

    expect(sessionRepo.getBackendState(session.id)).toEqual({
      sessionId: "claude-session-1",
    });

    sessionRepo.clearBackendState(session.id);
    expect(sessionRepo.getBackendState(session.id)).toBeNull();
  });

  it("hides archived sessions from list() unless explicitly included", () => {
    const db = createDatabase(":memory:");
    openDatabases.push(db);
    runMigrations(db);

    const sessionRepo = new SessionRepo(db);

    const session: SessionRecord = {
      id: "archived-session",
      backend: "codex",
      status: "terminated",
      displayName: "Archived Session",
      cwd: "/tmp/swarmd",
      model: "gpt-5",
      systemPrompt: undefined,
      backendCheckpoint: null,
      createdAt: "2026-03-13T00:00:00.000Z",
      updatedAt: "2026-03-13T00:00:00.000Z",
      lastError: null,
      contextUsage: null,
    };

    sessionRepo.create(session);
    sessionRepo.archiveSession(session.id);

    expect(sessionRepo.getById(session.id)?.id).toBe(session.id);
    expect(sessionRepo.list()).toEqual([]);
    expect(sessionRepo.list({ includeArchived: true })).toEqual([
      {
        ...session,
        updatedAt: expect.any(String),
      },
    ]);
  });

  it("upgrades legacy session schemas through the restored migration stack", () => {
    const db = createDatabase(":memory:");
    openDatabases.push(db);

    db.exec(`
      CREATE TABLE migrations (
        id TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL
      );

      INSERT INTO migrations (id, applied_at) VALUES
        ('001_initial_store_schema', '2026-03-13T00:00:00.000Z'),
        ('002_message_store', '2026-03-13T00:00:00.000Z'),
        ('003_session_backend_state', '2026-03-13T00:00:00.000Z');

      CREATE TABLE sessions (
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

      CREATE TABLE operations (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        type TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        result_json TEXT,
        error_json TEXT,
        created_at TEXT NOT NULL,
        completed_at TEXT
      );

      CREATE TABLE messages (
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

      CREATE INDEX idx_messages_session_order
        ON messages(session_id, order_key);

      CREATE INDEX idx_messages_source_msg
        ON messages(session_id, source_msg_id);

      CREATE TABLE session_backend_state (
        session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
        backend TEXT NOT NULL,
        state_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);

    db.prepare(
      `INSERT INTO sessions (
         id,
         backend,
         status,
         display_name,
         cwd,
         model,
         system_prompt,
         metadata_json,
         backend_checkpoint_json,
         runtime_config_json,
         created_at,
         updated_at,
         last_error_json
       ) VALUES (
         @id,
         @backend,
         @status,
         @display_name,
         @cwd,
         @model,
         @system_prompt,
         @metadata_json,
         @backend_checkpoint_json,
         @runtime_config_json,
         @created_at,
         @updated_at,
         @last_error_json
       )`,
    ).run({
      id: "legacy-session",
      backend: "codex",
      status: "idle",
      display_name: "Legacy Session",
      cwd: "/tmp/swarmd",
      model: "gpt-5.4",
      system_prompt: "legacy prompt",
      metadata_json: JSON.stringify({ existing: true }),
      backend_checkpoint_json: null,
      runtime_config_json: JSON.stringify({ backendConfig: {} }),
      created_at: "2026-03-13T00:00:00.000Z",
      updated_at: "2026-03-13T00:00:00.000Z",
      last_error_json: null,
    });
    db.prepare(
      `INSERT INTO session_backend_state (session_id, backend, state_json, updated_at)
       VALUES (@session_id, @backend, @state_json, @updated_at)`,
    ).run({
      session_id: "legacy-session",
      backend: "codex",
      state_json: JSON.stringify({ threadId: "thread-123" }),
      updated_at: "2026-03-13T00:05:00.000Z",
    });

    runMigrations(db);

    const sessionRow = db
      .prepare<
        { id: string },
        { metadata_json: string; context_usage_json: string | null; archived: number }
      >(
        `SELECT metadata_json, context_usage_json, archived
         FROM sessions
         WHERE id = @id`,
      )
      .get({ id: "legacy-session" });

    expect(sessionRow?.context_usage_json).toBeNull();
    expect(sessionRow?.archived).toBe(0);
    expect(JSON.parse(sessionRow!.metadata_json)).toEqual({
      existing: true,
      _backendState: { threadId: "thread-123" },
    });
    expect(
      db
        .prepare<[], { name: string }>(
          `SELECT name
           FROM pragma_table_info('sessions')
           WHERE name = 'context_usage_json'`,
        )
        .get(),
    ).toEqual({ name: "context_usage_json" });
    expect(
      db
        .prepare<[], { name: string }>(
          `SELECT name
           FROM pragma_table_info('sessions')
           WHERE name = 'archived'`,
        )
        .get(),
    ).toEqual({ name: "archived" });
    expect(
      db
        .prepare<[], { name: string }>(
          `SELECT name
           FROM sqlite_master
           WHERE type = 'table'
             AND name = 'session_backend_state'`,
        )
        .get(),
    ).toBeUndefined();
    expect(
      db
        .prepare<[], { id: string }>(
          `SELECT id
           FROM migrations
           WHERE id = '006_fold_backend_state_into_session_metadata'`,
        )
        .get(),
    ).toEqual({ id: "006_fold_backend_state_into_session_metadata" });
  });
});
