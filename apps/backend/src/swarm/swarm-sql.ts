import type { Database, MigrationDefinition } from "swarmd";

import type { ScheduledTask } from "../scheduler/schedule-types.js";
import type { MessageTargetContext } from "./types.js";

export const MIDDLEMAN_STORE_MIGRATIONS: readonly MigrationDefinition[] = [
  {
    id: "middleman_001_agent_tables",
    sql: `
      CREATE TABLE IF NOT EXISTS middleman_agents (
        session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK (role IN ('manager', 'worker')),
        manager_session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        archetype_id TEXT,
        memory_owner_session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        reply_target_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS middleman_manager_order (
        manager_session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
        sort_index INTEGER NOT NULL
      );
    `,
  },
  {
    id: "middleman_005_settings",
    sql: `
      CREATE TABLE IF NOT EXISTS middleman_settings (
        namespace TEXT NOT NULL,
        key TEXT NOT NULL,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (namespace, key)
      );
    `,
  },
  {
    id: "middleman_007_drop_auth_settings",
    sql: `
      DELETE FROM middleman_settings
      WHERE namespace = 'auth';
    `,
  },
  {
    id: "middleman_008_drop_schedule_table",
    sql: `
      DROP TABLE IF EXISTS middleman_schedules;
    `,
  },
  {
    id: "middleman_009_schedule_table",
    sql: `
      CREATE TABLE IF NOT EXISTS middleman_schedules (
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

      CREATE INDEX IF NOT EXISTS idx_middleman_schedules_manager_next_fire
        ON middleman_schedules(manager_session_id, next_fire_at, created_at);
    `,
  },
  {
    id: "middleman_010_drop_removed_tables",
    sql: `
      DROP TABLE IF EXISTS middleman_escalations;
    `,
  },
  {
    id: "middleman_011_drop_integration_profiles",
    sql: `
      DROP TABLE IF EXISTS middleman_integration_profiles;
    `,
  },
];

export interface MiddlemanAgentRow {
  sessionId: string;
  role: "manager" | "worker";
  managerSessionId: string;
  archetypeId?: string;
  memoryOwnerSessionId: string;
  replyTarget?: MessageTargetContext;
  createdAt: string;
  updatedAt: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function parseJsonObject(value: string | null | undefined): Record<string, unknown> {
  if (!value) {
    return {};
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function serializeJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function parseOptionalString(value: string | null | undefined): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function parseScheduledTaskRow(row: {
  id: string;
  manager_session_id: string;
  name: string;
  description: string | null;
  cron: string;
  message: string;
  enabled: number;
  one_shot: number;
  timezone: string;
  created_at: string;
  updated_at: string;
  next_fire_at: string;
  last_fired_at: string | null;
}): ScheduledTask {
  return {
    id: row.id,
    managerId: row.manager_session_id,
    name: row.name,
    description: parseOptionalString(row.description),
    cron: row.cron,
    message: row.message,
    enabled: row.enabled !== 0,
    oneShot: row.one_shot !== 0,
    timezone: row.timezone,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    nextFireAt: row.next_fire_at,
    lastFiredAt: parseOptionalString(row.last_fired_at),
  };
}

export class MiddlemanAgentRepo {
  constructor(private readonly db: Database) {}

  list(): MiddlemanAgentRow[] {
    return this.db
      .prepare<
        [],
        {
          session_id: string;
          role: "manager" | "worker";
          manager_session_id: string;
          archetype_id: string | null;
          memory_owner_session_id: string;
          reply_target_json: string | null;
          created_at: string;
          updated_at: string;
        }
      >(
        `SELECT
           session_id,
           role,
           manager_session_id,
           archetype_id,
           memory_owner_session_id,
           reply_target_json,
           created_at,
           updated_at
         FROM middleman_agents
         ORDER BY created_at ASC`,
      )
      .all()
      .map((row: {
        session_id: string;
        role: "manager" | "worker";
        manager_session_id: string;
        archetype_id: string | null;
        memory_owner_session_id: string;
        reply_target_json: string | null;
        created_at: string;
        updated_at: string;
      }) => ({
        sessionId: row.session_id,
        role: row.role,
        managerSessionId: row.manager_session_id,
        archetypeId: row.archetype_id ?? undefined,
        memoryOwnerSessionId: row.memory_owner_session_id,
        replyTarget: row.reply_target_json
          ? (parseJsonObject(row.reply_target_json) as MessageTargetContext)
          : undefined,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }));
  }

  get(sessionId: string): MiddlemanAgentRow | null {
    return this.list().find((row) => row.sessionId === sessionId) ?? null;
  }

  create(input: {
    sessionId: string;
    role: "manager" | "worker";
    managerSessionId: string;
    archetypeId?: string;
    memoryOwnerSessionId: string;
    replyTarget?: MessageTargetContext;
    createdAt?: string;
  }): MiddlemanAgentRow {
    const createdAt = input.createdAt ?? nowIso();
    this.db
      .prepare<{
        session_id: string;
        role: "manager" | "worker";
        manager_session_id: string;
        archetype_id: string | null;
        memory_owner_session_id: string;
        reply_target_json: string | null;
        created_at: string;
        updated_at: string;
      }>(
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
      )
      .run({
        session_id: input.sessionId,
        role: input.role,
        manager_session_id: input.managerSessionId,
        archetype_id: input.archetypeId ?? null,
        memory_owner_session_id: input.memoryOwnerSessionId,
        reply_target_json: input.replyTarget ? serializeJson(input.replyTarget) : null,
        created_at: createdAt,
        updated_at: createdAt,
      });

    return this.get(input.sessionId)!;
  }

  updateReplyTarget(sessionId: string, replyTarget?: MessageTargetContext): void {
    this.db
      .prepare<{ session_id: string; reply_target_json: string | null; updated_at: string }>(
        `UPDATE middleman_agents
         SET reply_target_json = @reply_target_json,
             updated_at = @updated_at
         WHERE session_id = @session_id`,
      )
      .run({
        session_id: sessionId,
        reply_target_json: replyTarget ? serializeJson(replyTarget) : null,
        updated_at: nowIso(),
      });
  }

  delete(sessionId: string): void {
    this.db.prepare<{ session_id: string }>("DELETE FROM middleman_agents WHERE session_id = @session_id").run({
      session_id: sessionId,
    });
  }
}

export class MiddlemanManagerOrderRepo {
  constructor(private readonly db: Database) {}

  list(): string[] {
    return this.db
      .prepare<[], { manager_session_id: string }>(
        `SELECT manager_session_id
         FROM middleman_manager_order
         ORDER BY sort_index ASC, manager_session_id ASC`,
      )
      .all()
      .map((row: { manager_session_id: string }) => row.manager_session_id);
  }

  ensure(managerIds: string[]): string[] {
    const tx = this.db.transaction((ids: string[]) => {
      const existing = new Set(this.list());
      let sortIndex = this.list().length;

      for (const managerId of ids) {
        if (existing.has(managerId)) {
          continue;
        }

        this.db
          .prepare<{ manager_session_id: string; sort_index: number }>(
            `INSERT INTO middleman_manager_order (manager_session_id, sort_index)
             VALUES (@manager_session_id, @sort_index)`,
          )
          .run({
            manager_session_id: managerId,
            sort_index: sortIndex,
          });
        sortIndex += 1;
      }
    });

    tx(managerIds);
    return this.list();
  }

  reorder(managerIds: string[]): string[] {
    const tx = this.db.transaction((ids: string[]) => {
      this.db.prepare("DELETE FROM middleman_manager_order").run();

      ids.forEach((managerId, index) => {
        this.db
          .prepare<{ manager_session_id: string; sort_index: number }>(
            `INSERT INTO middleman_manager_order (manager_session_id, sort_index)
             VALUES (@manager_session_id, @sort_index)`,
          )
          .run({
            manager_session_id: managerId,
            sort_index: index,
          });
      });
    });

    tx(managerIds);
    return this.list();
  }

  remove(managerId: string): void {
    this.db.prepare<{ manager_session_id: string }>(
      "DELETE FROM middleman_manager_order WHERE manager_session_id = @manager_session_id",
    ).run({ manager_session_id: managerId });

    this.reorder(this.list());
  }
}

export class MiddlemanScheduleRepo {
  constructor(private readonly db: Database) {}

  listForManager(managerId: string): ScheduledTask[] {
    return this.db
      .prepare<
        { manager_session_id: string },
        {
          id: string;
          manager_session_id: string;
          name: string;
          description: string | null;
          cron: string;
          message: string;
          enabled: number;
          one_shot: number;
          timezone: string;
          created_at: string;
          updated_at: string;
          next_fire_at: string;
          last_fired_at: string | null;
        }
      >(
        `SELECT
           id,
           manager_session_id,
           name,
           description,
           cron,
           message,
           enabled,
           one_shot,
           timezone,
           created_at,
           updated_at,
           next_fire_at,
           last_fired_at
         FROM middleman_schedules
         WHERE manager_session_id = @manager_session_id
         ORDER BY next_fire_at ASC, created_at ASC, id ASC`,
      )
      .all({ manager_session_id: managerId })
      .map((row) => parseScheduledTaskRow(row));
  }

  getForManager(managerId: string, scheduleId: string): ScheduledTask | undefined {
    const row = this.db
      .prepare<
        { manager_session_id: string; id: string },
        {
          id: string;
          manager_session_id: string;
          name: string;
          description: string | null;
          cron: string;
          message: string;
          enabled: number;
          one_shot: number;
          timezone: string;
          created_at: string;
          updated_at: string;
          next_fire_at: string;
          last_fired_at: string | null;
        }
      >(
        `SELECT
           id,
           manager_session_id,
           name,
           description,
           cron,
           message,
           enabled,
           one_shot,
           timezone,
           created_at,
           updated_at,
           next_fire_at,
           last_fired_at
         FROM middleman_schedules
         WHERE manager_session_id = @manager_session_id
           AND id = @id`,
      )
      .get({ manager_session_id: managerId, id: scheduleId });

    return row ? parseScheduledTaskRow(row) : undefined;
  }

  create(schedule: ScheduledTask): ScheduledTask {
    this.db
      .prepare<{
        id: string;
        manager_session_id: string;
        name: string;
        description: string | null;
        cron: string;
        message: string;
        enabled: number;
        one_shot: number;
        timezone: string;
        created_at: string;
        updated_at: string;
        next_fire_at: string;
        last_fired_at: string | null;
      }>(
        `INSERT INTO middleman_schedules (
           id,
           manager_session_id,
           name,
           description,
           cron,
           message,
           enabled,
           one_shot,
           timezone,
           created_at,
           updated_at,
           next_fire_at,
           last_fired_at
         ) VALUES (
           @id,
           @manager_session_id,
           @name,
           @description,
           @cron,
           @message,
           @enabled,
           @one_shot,
           @timezone,
           @created_at,
           @updated_at,
           @next_fire_at,
           @last_fired_at
         )`,
      )
      .run({
        id: schedule.id,
        manager_session_id: schedule.managerId,
        name: schedule.name,
        description: schedule.description ?? null,
        cron: schedule.cron,
        message: schedule.message,
        enabled: schedule.enabled ? 1 : 0,
        one_shot: schedule.oneShot ? 1 : 0,
        timezone: schedule.timezone,
        created_at: schedule.createdAt,
        updated_at: schedule.updatedAt,
        next_fire_at: schedule.nextFireAt,
        last_fired_at: schedule.lastFiredAt ?? null,
      });

    return this.getForManager(schedule.managerId, schedule.id)!;
  }

  update(schedule: ScheduledTask): ScheduledTask {
    this.db
      .prepare<{
        id: string;
        manager_session_id: string;
        name: string;
        description: string | null;
        cron: string;
        message: string;
        enabled: number;
        one_shot: number;
        timezone: string;
        updated_at: string;
        next_fire_at: string;
        last_fired_at: string | null;
      }>(
        `UPDATE middleman_schedules
         SET name = @name,
             description = @description,
             cron = @cron,
             message = @message,
             enabled = @enabled,
             one_shot = @one_shot,
             timezone = @timezone,
             updated_at = @updated_at,
             next_fire_at = @next_fire_at,
             last_fired_at = @last_fired_at
         WHERE manager_session_id = @manager_session_id
           AND id = @id`,
      )
      .run({
        id: schedule.id,
        manager_session_id: schedule.managerId,
        name: schedule.name,
        description: schedule.description ?? null,
        cron: schedule.cron,
        message: schedule.message,
        enabled: schedule.enabled ? 1 : 0,
        one_shot: schedule.oneShot ? 1 : 0,
        timezone: schedule.timezone,
        updated_at: schedule.updatedAt,
        next_fire_at: schedule.nextFireAt,
        last_fired_at: schedule.lastFiredAt ?? null,
      });

    const updated = this.getForManager(schedule.managerId, schedule.id);
    if (!updated) {
      throw new Error(`Unknown schedule: ${schedule.id}`);
    }

    return updated;
  }

  remove(managerId: string, scheduleId: string): ScheduledTask {
    const existing = this.getForManager(managerId, scheduleId);
    if (!existing) {
      throw new Error(`Unknown schedule: ${scheduleId}`);
    }

    this.db
      .prepare<{ manager_session_id: string; id: string }>(
        `DELETE FROM middleman_schedules
         WHERE manager_session_id = @manager_session_id
           AND id = @id`,
      )
      .run({
        manager_session_id: managerId,
        id: scheduleId,
      });

    return existing;
  }

  deleteForManager(managerId: string): string[] {
    const scheduleIds = this.listForManager(managerId).map((schedule) => schedule.id);
    this.db
      .prepare<{ manager_session_id: string }>(
        "DELETE FROM middleman_schedules WHERE manager_session_id = @manager_session_id",
      )
      .run({ manager_session_id: managerId });
    return scheduleIds;
  }
}

export class MiddlemanSettingsRepo {
  constructor(private readonly db: Database) {}

  listNamespace(namespace: string): Array<{ key: string; value: unknown; updatedAt: string }> {
    return this.db
      .prepare<
        { namespace: string },
        { key: string; value_json: string; updated_at: string }
      >(
        `SELECT key, value_json, updated_at
         FROM middleman_settings
         WHERE namespace = @namespace
         ORDER BY key ASC`,
      )
      .all({ namespace })
      .map((row: { key: string; value_json: string; updated_at: string }) => ({
        key: row.key,
        value: JSON.parse(row.value_json),
        updatedAt: row.updated_at,
      }));
  }

  get(namespace: string, key: string): unknown {
    const row = this.db
      .prepare<{ namespace: string; key: string }, { value_json: string }>(
        `SELECT value_json
         FROM middleman_settings
         WHERE namespace = @namespace
           AND key = @key`,
      )
      .get({ namespace, key });

    return row ? JSON.parse(row.value_json) : undefined;
  }

  set(namespace: string, key: string, value: unknown): void {
    this.db
      .prepare<{ namespace: string; key: string; value_json: string; updated_at: string }>(
        `INSERT INTO middleman_settings (namespace, key, value_json, updated_at)
         VALUES (@namespace, @key, @value_json, @updated_at)
         ON CONFLICT(namespace, key) DO UPDATE SET
           value_json = excluded.value_json,
           updated_at = excluded.updated_at`,
      )
      .run({
        namespace,
        key,
        value_json: serializeJson(value),
        updated_at: nowIso(),
      });
  }

  delete(namespace: string, key: string): void {
    this.db.prepare<{ namespace: string; key: string }>(
      `DELETE FROM middleman_settings
       WHERE namespace = @namespace
         AND key = @key`,
    ).run({ namespace, key });
  }

  listEnv(): Record<string, string> {
    return Object.fromEntries(
      this.listNamespace("env")
        .filter((entry): entry is { key: string; value: string; updatedAt: string } => typeof entry.value === "string")
        .map((entry) => [entry.key, entry.value]),
    );
  }
}
