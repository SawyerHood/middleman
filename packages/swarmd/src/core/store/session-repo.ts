import type { Database } from "./db.js";
import {
  nowTimestamp,
  parseJsonObject,
  parseJsonValue,
  parseSessionContextUsage,
  parseSessionError,
  serializeJson,
} from "./shared.js";
import type {
  SessionContextUsage,
  SessionErrorInfo,
  SessionRecord,
  SessionRuntimeConfig,
  SessionStatus,
} from "../types/index.js";

interface SessionRow {
  id: string;
  backend: SessionRecord["backend"];
  status: SessionStatus;
  display_name: string;
  cwd: string;
  model: string;
  system_prompt: string | null;
  backend_checkpoint_json: string | null;
  runtime_config_json: string;
  created_at: string;
  updated_at: string;
  last_error_json: string | null;
  context_usage_json: string | null;
  archived: number;
}

interface SessionRuntimeConfigExtras {
  deliveryDefaults?: SessionRuntimeConfig["deliveryDefaults"];
  backendConfig: Record<string, unknown>;
}

function mapSessionRow(row: SessionRow): SessionRecord {
  return {
    id: row.id,
    backend: row.backend,
    status: row.status,
    displayName: row.display_name,
    cwd: row.cwd,
    model: row.model,
    systemPrompt: row.system_prompt ?? undefined,
    backendCheckpoint: parseJsonValue(
      row.backend_checkpoint_json,
      "backend_checkpoint_json",
    ) as SessionRecord["backendCheckpoint"],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastError: parseSessionError(row.last_error_json),
    contextUsage: parseSessionContextUsage(row.context_usage_json),
  };
}

function parseRuntimeConfigExtras(value: string): SessionRuntimeConfigExtras {
  const parsed = parseJsonObject(value, "runtime_config_json");
  const backendConfig =
    typeof parsed.backendConfig === "object" &&
    parsed.backendConfig !== null &&
    !Array.isArray(parsed.backendConfig)
      ? (parsed.backendConfig as Record<string, unknown>)
      : {};

  const maybeDeliveryDefaults = parsed.deliveryDefaults;
  const busyMode =
    maybeDeliveryDefaults &&
    typeof maybeDeliveryDefaults === "object" &&
    !Array.isArray(maybeDeliveryDefaults) &&
    (maybeDeliveryDefaults as { busyMode?: unknown }).busyMode;

  return {
    ...(busyMode === "auto" || busyMode === "queue" || busyMode === "interrupt"
      ? { deliveryDefaults: { busyMode } }
      : {}),
    backendConfig,
  };
}

export class SessionRepo {
  constructor(private db: Database) {}

  create(
    session: SessionRecord,
    runtimeConfig?: Pick<SessionRuntimeConfig, "deliveryDefaults" | "backendConfig">,
  ): void {
    this.db
      .prepare<{
        id: string;
        backend: SessionRecord["backend"];
        status: SessionStatus;
        display_name: string;
        cwd: string;
        model: string;
        system_prompt: string | null;
        metadata_json: string;
        backend_checkpoint_json: string | null;
        runtime_config_json: string;
        created_at: string;
        updated_at: string;
        last_error_json: string | null;
        context_usage_json: string | null;
      }>(
        `
        INSERT INTO sessions (
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
          last_error_json,
          context_usage_json
        )
        VALUES (
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
          @last_error_json,
          @context_usage_json
        )
      `,
      )
      .run({
        id: session.id,
        backend: session.backend,
        status: session.status,
        display_name: session.displayName,
        cwd: session.cwd,
        model: session.model,
        system_prompt: session.systemPrompt ?? null,
        metadata_json: serializeJson({}),
        backend_checkpoint_json:
          session.backendCheckpoint === null ? null : serializeJson(session.backendCheckpoint),
        runtime_config_json: serializeJson({
          ...(runtimeConfig?.deliveryDefaults
            ? { deliveryDefaults: runtimeConfig.deliveryDefaults }
            : {}),
          backendConfig: { ...(runtimeConfig?.backendConfig ?? {}) },
        }),
        created_at: session.createdAt,
        updated_at: session.updatedAt,
        last_error_json: session.lastError ? serializeJson(session.lastError) : null,
        context_usage_json: session.contextUsage ? serializeJson(session.contextUsage) : null,
      });
  }

  getById(id: string): SessionRecord | null {
    const row = this.db
      .prepare<{ id: string }, SessionRow>(
        `SELECT
          id,
          backend,
          status,
          display_name,
          cwd,
          model,
          system_prompt,
          backend_checkpoint_json,
          runtime_config_json,
          created_at,
          updated_at,
          last_error_json,
          context_usage_json,
          archived
        FROM sessions
        WHERE id = @id`,
      )
      .get({ id });

    return row ? mapSessionRow(row) : null;
  }

  list(filter?: { status?: SessionStatus[]; includeArchived?: boolean }): SessionRecord[] {
    const includeArchived = filter?.includeArchived === true;

    if (!filter?.status?.length) {
      return this.db
        .prepare<[], SessionRow>(
          `SELECT
            id,
            backend,
            status,
            display_name,
            cwd,
            model,
            system_prompt,
            backend_checkpoint_json,
            runtime_config_json,
            created_at,
            updated_at,
            last_error_json,
            context_usage_json,
            archived
          FROM sessions
          ${includeArchived ? "" : "WHERE archived = 0"}
          ORDER BY created_at ASC`,
        )
        .all()
        .map(mapSessionRow);
    }

    const placeholders = filter.status.map((_, index) => `@status${index}`).join(", ");
    const params = Object.fromEntries(
      filter.status.map((status, index) => [`status${index}`, status]),
    );

    return this.db
      .prepare<Record<string, SessionStatus>, SessionRow>(
        `SELECT
          id,
          backend,
          status,
          display_name,
          cwd,
          model,
          system_prompt,
          backend_checkpoint_json,
          runtime_config_json,
          created_at,
          updated_at,
          last_error_json,
          context_usage_json,
          archived
        FROM sessions
        WHERE ${includeArchived ? "" : "archived = 0 AND "}status IN (${placeholders})
        ORDER BY created_at ASC`,
      )
      .all(params)
      .map(mapSessionRow);
  }

  archiveSession(id: string): void {
    this.db
      .prepare<{ id: string; updated_at: string }>(
        `UPDATE sessions
         SET archived = 1,
             updated_at = @updated_at
         WHERE id = @id`,
      )
      .run({
        id,
        updated_at: nowTimestamp(),
      });
  }

  isArchived(id: string): boolean {
    const row = this.db
      .prepare<{ id: string }, { archived: number }>(
        `SELECT archived
         FROM sessions
         WHERE id = @id`,
      )
      .get({ id });

    return row?.archived === 1;
  }

  updateStatus(
    id: string,
    status: SessionStatus,
    error: SessionErrorInfo | null,
    contextUsage: SessionContextUsage | null,
  ): void {
    this.db
      .prepare<{
        id: string;
        status: SessionStatus;
        updated_at: string;
        last_error_json: string | null;
        context_usage_json: string | null;
      }>(
        `UPDATE sessions
        SET status = @status,
            updated_at = @updated_at,
            last_error_json = @last_error_json,
            context_usage_json = @context_usage_json
        WHERE id = @id`,
      )
      .run({
        id,
        status,
        updated_at: nowTimestamp(),
        last_error_json: error ? serializeJson(error) : null,
        context_usage_json: contextUsage ? serializeJson(contextUsage) : null,
      });
  }

  updateDisplayName(id: string, displayName: string): void {
    this.db
      .prepare<{ id: string; display_name: string; updated_at: string }>(
        `UPDATE sessions
        SET display_name = @display_name,
            updated_at = @updated_at
        WHERE id = @id`,
      )
      .run({
        id,
        display_name: displayName,
        updated_at: nowTimestamp(),
      });
  }

  updateCheckpoint(id: string, checkpoint: SessionRecord["backendCheckpoint"]): void {
    this.db
      .prepare<{ id: string; backend_checkpoint_json: string | null; updated_at: string }>(
        `UPDATE sessions
        SET backend_checkpoint_json = @backend_checkpoint_json,
            updated_at = @updated_at
        WHERE id = @id`,
      )
      .run({
        id,
        backend_checkpoint_json: checkpoint === null ? null : serializeJson(checkpoint),
        updated_at: nowTimestamp(),
      });
  }

  getBackendState(sessionId: string): Record<string, unknown> | null {
    const metadata = this.getMetadata(sessionId);
    const state = metadata?._backendState;

    return state && typeof state === "object" && !Array.isArray(state)
      ? (state as Record<string, unknown>)
      : null;
  }

  updateBackendState(sessionId: string, state: Record<string, unknown>): void {
    const metadata = this.getMetadata(sessionId);
    if (!metadata) {
      return;
    }

    metadata._backendState = state;
    this.persistMetadata(sessionId, metadata);
  }

  clearBackendState(sessionId: string): void {
    const metadata = this.getMetadata(sessionId);
    if (!metadata) {
      return;
    }

    delete metadata._backendState;
    this.persistMetadata(sessionId, metadata);
  }

  getRuntimeConfig(sessionId: string): SessionRuntimeConfigExtras {
    const row = this.db
      .prepare<{ sessionId: string }, { runtime_config_json: string }>(
        `SELECT runtime_config_json
         FROM sessions
         WHERE id = @sessionId`,
      )
      .get({ sessionId });

    return row ? parseRuntimeConfigExtras(row.runtime_config_json) : { backendConfig: {} };
  }

  updateRuntimeConfig(
    sessionId: string,
    runtimeConfig: Pick<SessionRuntimeConfig, "deliveryDefaults" | "backendConfig">,
  ): void {
    this.db
      .prepare<{ sessionId: string; runtime_config_json: string; updated_at: string }>(
        `UPDATE sessions
         SET runtime_config_json = @runtime_config_json,
             updated_at = @updated_at
         WHERE id = @sessionId`,
      )
      .run({
        sessionId,
        runtime_config_json: serializeJson({
          ...(runtimeConfig.deliveryDefaults
            ? { deliveryDefaults: runtimeConfig.deliveryDefaults }
            : {}),
          backendConfig: { ...(runtimeConfig.backendConfig ?? {}) },
        }),
        updated_at: nowTimestamp(),
      });
  }

  resetState(
    sessionId: string,
    input: {
      systemPrompt: string;
      runtimeConfig?: Pick<SessionRuntimeConfig, "deliveryDefaults" | "backendConfig">;
      updatedAt?: string;
    },
  ): void {
    this.db
      .prepare<{
        sessionId: string;
        system_prompt: string;
        runtime_config_json: string;
        updated_at: string;
      }>(
        `UPDATE sessions
         SET status = 'stopped',
             system_prompt = @system_prompt,
             backend_checkpoint_json = NULL,
             runtime_config_json = @runtime_config_json,
             last_error_json = NULL,
             context_usage_json = NULL,
             updated_at = @updated_at
         WHERE id = @sessionId`,
      )
      .run({
        sessionId,
        system_prompt: input.systemPrompt,
        runtime_config_json: serializeJson({
          ...(input.runtimeConfig?.deliveryDefaults
            ? { deliveryDefaults: input.runtimeConfig.deliveryDefaults }
            : {}),
          backendConfig: { ...(input.runtimeConfig?.backendConfig ?? {}) },
        }),
        updated_at: input.updatedAt ?? nowTimestamp(),
      });
  }

  delete(id: string): void {
    const removeSession = this.db.transaction((sessionId: string) => {
      this.db.prepare("DELETE FROM operations WHERE session_id = ?").run(sessionId);
      this.db.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId);
    });

    removeSession(id);
  }

  private getMetadata(sessionId: string): Record<string, unknown> | null {
    const row = this.db
      .prepare<{ id: string }, { metadata_json: string }>(
        `SELECT metadata_json
         FROM sessions
         WHERE id = @id`,
      )
      .get({ id: sessionId });

    return row ? parseJsonObject(row.metadata_json, "metadata_json") : null;
  }

  private persistMetadata(sessionId: string, metadata: Record<string, unknown>): void {
    this.db
      .prepare<{ id: string; metadata_json: string; updated_at: string }>(
        `UPDATE sessions
         SET metadata_json = @metadata_json,
             updated_at = @updated_at
         WHERE id = @id`,
      )
      .run({
        id: sessionId,
        metadata_json: serializeJson(metadata),
        updated_at: nowTimestamp(),
      });
  }
}
