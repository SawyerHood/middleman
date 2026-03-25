import { afterEach, describe, expect, it } from "vitest";
import {
  SessionRepo,
  createDatabase,
  runMigrations,
  type Database,
  type SessionRecord,
} from "swarmd";

import { MIDDLEMAN_STORE_MIGRATIONS } from "../swarm/swarm-sql.js";

function createSession(id: string, displayName: string): SessionRecord {
  return {
    id,
    backend: "codex",
    status: "idle",
    displayName,
    cwd: "/tmp/middleman",
    model: "gpt-5.4",
    systemPrompt: undefined,
    backendCheckpoint: null,
    createdAt: "2026-03-13T00:00:00.000Z",
    updatedAt: "2026-03-13T00:00:00.000Z",
    lastError: null,
    contextUsage: null,
  };
}

describe("MIDDLEMAN_STORE_MIGRATIONS", () => {
  const openDatabases: Database[] = [];

  afterEach(() => {
    while (openDatabases.length > 0) {
      openDatabases.pop()?.close();
    }
  });

  it("upgrades legacy middleman tables and tool-call metadata through the restored migrations", () => {
    const db = createDatabase(":memory:");
    openDatabases.push(db);
    runMigrations(db);

    const sessionRepo = new SessionRepo(db);
    sessionRepo.create(createSession("manager-1", "Manager 1"));
    sessionRepo.create(createSession("worker-1", "Worker 1"));

    db.prepare<{ id: string; applied_at: string }>(
      `INSERT INTO migrations (id, applied_at)
       VALUES (@id, @applied_at)`,
    ).run({
      id: "middleman_001_base_schema",
      applied_at: "2026-03-13T00:00:00.000Z",
    });

    db.exec(`
      CREATE TABLE middleman_agents (
        session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK (role IN ('manager', 'worker')),
        manager_session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        archetype_id TEXT,
        memory_owner_session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        reply_target_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE middleman_manager_order (
        manager_session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
        sort_index INTEGER NOT NULL
      );

      CREATE TABLE middleman_settings (
        namespace TEXT NOT NULL,
        key TEXT NOT NULL,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (namespace, key)
      );

      CREATE TABLE middleman_schedules (
        id TEXT PRIMARY KEY,
        manager_session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        description TEXT,
        cron TEXT NOT NULL,
        message TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
        one_shot INTEGER NOT NULL DEFAULT 0 CHECK (one_shot IN (0, 1)),
        timezone TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        next_fire_at TEXT NOT NULL,
        last_fired_at TEXT
      );

      CREATE INDEX idx_middleman_schedules_manager_next_fire
        ON middleman_schedules(manager_session_id, next_fire_at, created_at);
    `);

    db.prepare(
      `INSERT INTO middleman_agents (
         session_id,
         role,
         manager_session_id,
         archetype_id,
         memory_owner_session_id,
         reply_target_json,
         created_at,
         updated_at
       ) VALUES (
         @session_id,
         @role,
         @manager_session_id,
         @archetype_id,
         @memory_owner_session_id,
         @reply_target_json,
         @created_at,
         @updated_at
       )`,
    ).run({
      session_id: "worker-1",
      role: "worker",
      manager_session_id: "manager-1",
      archetype_id: "researcher",
      memory_owner_session_id: "manager-1",
      reply_target_json: JSON.stringify({ type: "conversation", messageId: "msg-1" }),
      created_at: "2026-03-13T00:00:00.000Z",
      updated_at: "2026-03-13T00:01:00.000Z",
    });
    db.prepare(
      `INSERT INTO middleman_settings (namespace, key, value_json, updated_at)
       VALUES (@namespace, @key, @value_json, @updated_at)`,
    ).run({
      namespace: "env",
      key: "OPENAI_API_KEY",
      value_json: JSON.stringify("test-key"),
      updated_at: "2026-03-13T00:02:00.000Z",
    });
    db.prepare(
      `INSERT INTO messages (
         id,
         session_id,
         source,
         source_msg_id,
         kind,
         role,
         content_json,
         order_key,
         created_at,
         metadata_json
       ) VALUES (
         @id,
         @session_id,
         @source,
         @source_msg_id,
         @kind,
         @role,
         @content_json,
         @order_key,
         @created_at,
         @metadata_json
       )`,
    ).run({
      id: "message-1",
      session_id: "worker-1",
      source: "assistant",
      source_msg_id: null,
      kind: "tool_call",
      role: "assistant",
      content_json: JSON.stringify({ toolName: "exec_command" }),
      order_key: "0001",
      created_at: "2026-03-13T00:03:00.000Z",
      metadata_json: JSON.stringify({
        middleman: {
          version: 1,
          renderAs: "agent_tool_call",
          visibility: "hidden",
          routing: {
            fromAgentId: "worker-1",
            toAgentId: "manager-1",
          },
          event: {
            text: "running command",
          },
        },
      }),
    });

    runMigrations(db, { migrations: MIDDLEMAN_STORE_MIGRATIONS });

    expect(
      db
        .prepare<[], { name: string }>(
          `SELECT name
           FROM pragma_table_info('middleman_agents')
           ORDER BY cid`,
        )
        .all()
        .map((row) => row.name),
    ).toEqual([
      "session_id",
      "role",
      "manager_session_id",
      "archetype_id",
      "memory_owner_session_id",
      "reply_target_json",
    ]);
    expect(
      db
        .prepare<[], { name: string }>(
          `SELECT name
           FROM pragma_table_info('middleman_settings')
           ORDER BY cid`,
        )
        .all()
        .map((row) => row.name),
    ).toEqual(["namespace", "key", "value_json"]);
    expect(
      db
        .prepare<
          [],
          {
            session_id: string;
            manager_session_id: string;
            archetype_id: string | null;
            memory_owner_session_id: string;
            reply_target_json: string | null;
          }
        >(
          `SELECT
             session_id,
             manager_session_id,
             archetype_id,
             memory_owner_session_id,
             reply_target_json
           FROM middleman_agents`,
        )
        .get(),
    ).toEqual({
      session_id: "worker-1",
      manager_session_id: "manager-1",
      archetype_id: "researcher",
      memory_owner_session_id: "manager-1",
      reply_target_json: JSON.stringify({ type: "conversation", messageId: "msg-1" }),
    });
    expect(
      db
        .prepare<{ namespace: string; key: string }, { value_json: string }>(
          `SELECT value_json
           FROM middleman_settings
           WHERE namespace = @namespace
             AND key = @key`,
        )
        .get({ namespace: "env", key: "OPENAI_API_KEY" }),
    ).toEqual({
      value_json: JSON.stringify("test-key"),
    });
    expect(
      JSON.parse(
        db
          .prepare<{ id: string }, { metadata_json: string }>(
            `SELECT metadata_json
             FROM messages
             WHERE id = @id`,
          )
          .get({ id: "message-1" })!.metadata_json,
      ),
    ).toEqual({
      middleman: {
        version: 1,
        renderAs: "agent_tool_call",
        visibility: "hidden",
        routing: {
          fromAgentId: "worker-1",
          toAgentId: "manager-1",
        },
        event: {},
      },
    });
    expect(
      db
        .prepare<[], { name: string }>(
          `SELECT name
           FROM sqlite_master
           WHERE type = 'index'
             AND name = 'idx_messages_middleman_visible_session'`,
        )
        .get(),
    ).toEqual({ name: "idx_messages_middleman_visible_session" });
    expect(
      db
        .prepare<[], { name: string }>(
          `SELECT name
           FROM sqlite_master
           WHERE type = 'index'
             AND name = 'idx_messages_middleman_hidden_routing'`,
        )
        .get(),
    ).toEqual({ name: "idx_messages_middleman_hidden_routing" });
    expect(
      db
        .prepare<[], { name: string }>(
          `SELECT name
           FROM sqlite_master
           WHERE type = 'index'
             AND name = 'idx_messages_tool_name_session_role'`,
        )
        .get(),
    ).toEqual({ name: "idx_messages_tool_name_session_role" });
    expect(
      db
        .prepare<[], { id: string }>(
          `SELECT id
           FROM migrations
           WHERE id = 'middleman_003_compact_agent_tool_call_storage'`,
        )
        .get(),
    ).toEqual({ id: "middleman_003_compact_agent_tool_call_storage" });
  });
});
