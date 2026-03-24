import type { Database } from "./db.js";
import { parseJsonObject, parseJsonValue, serializeJson } from "./shared.js";
import type { SwarmdMessage } from "../types/index.js";

interface MessageRow {
  id: string;
  session_id: string;
  source: SwarmdMessage["source"];
  source_msg_id: string | null;
  kind: string;
  role: SwarmdMessage["role"];
  content_json: string;
  order_key: string;
  created_at: string;
  metadata_json: string;
}

function mapMessageRow(row: MessageRow): SwarmdMessage {
  return {
    id: row.id,
    sessionId: row.session_id,
    source: row.source,
    sourceMessageId: row.source_msg_id,
    kind: row.kind,
    role: row.role,
    content: parseJsonValue(row.content_json, "content_json"),
    orderKey: row.order_key,
    createdAt: row.created_at,
    metadata: parseJsonObject(row.metadata_json, "metadata_json"),
  };
}

export class MessageRepo {
  constructor(private db: Database) {}

  create(message: SwarmdMessage): void {
    this.db
      .prepare<{
        id: string;
        session_id: string;
        source: SwarmdMessage["source"];
        source_msg_id: string | null;
        kind: string;
        role: SwarmdMessage["role"];
        content_json: string;
        order_key: string;
        created_at: string;
        metadata_json: string;
      }>(
        `
        INSERT INTO messages (
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
        )
        VALUES (
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
        )
      `,
      )
      .run({
        id: message.id,
        session_id: message.sessionId,
        source: message.source,
        source_msg_id: message.sourceMessageId,
        kind: message.kind,
        role: message.role,
        content_json: serializeJson(message.content),
        order_key: message.orderKey,
        created_at: message.createdAt,
        metadata_json: serializeJson(message.metadata),
      });
  }

  getById(id: string): SwarmdMessage | null {
    const row = this.db
      .prepare<{ id: string }, MessageRow>(
        `SELECT
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
        FROM messages
        WHERE id = @id`,
      )
      .get({ id });

    return row ? mapMessageRow(row) : null;
  }

  getLatestBySourceMessageId(sessionId: string, sourceMessageId: string): SwarmdMessage | null {
    const row = this.db
      .prepare<{ session_id: string; source_msg_id: string }, MessageRow>(
        `SELECT
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
        FROM messages
        WHERE session_id = @session_id
          AND source_msg_id = @source_msg_id
        ORDER BY order_key DESC
        LIMIT 1`,
      )
      .get({
        session_id: sessionId,
        source_msg_id: sourceMessageId,
      });

    return row ? mapMessageRow(row) : null;
  }

  listBySession(
    sessionId: string,
    options?: {
      after?: string;
      limit?: number;
    },
  ): SwarmdMessage[] {
    if (options?.after !== undefined && options.limit !== undefined) {
      return this.db
        .prepare<{ session_id: string; after: string; limit: number }, MessageRow>(
          `SELECT
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
          FROM messages
          WHERE session_id = @session_id
            AND order_key > @after
          ORDER BY order_key ASC
          LIMIT @limit`,
        )
        .all({ session_id: sessionId, after: options.after, limit: options.limit })
        .map(mapMessageRow);
    }

    if (options?.after !== undefined) {
      return this.db
        .prepare<{ session_id: string; after: string }, MessageRow>(
          `SELECT
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
          FROM messages
          WHERE session_id = @session_id
            AND order_key > @after
          ORDER BY order_key ASC`,
        )
        .all({ session_id: sessionId, after: options.after })
        .map(mapMessageRow);
    }

    if (options?.limit !== undefined) {
      return this.db
        .prepare<{ session_id: string; limit: number }, MessageRow>(
          `SELECT
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
          FROM messages
          WHERE session_id = @session_id
          ORDER BY order_key ASC
          LIMIT @limit`,
        )
        .all({ session_id: sessionId, limit: options.limit })
        .map(mapMessageRow);
    }

    return this.db
      .prepare<{ session_id: string }, MessageRow>(
        `SELECT
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
        FROM messages
        WHERE session_id = @session_id
        ORDER BY order_key ASC`,
      )
      .all({ session_id: sessionId })
      .map(mapMessageRow);
  }

  listVisibleTranscriptMessages(
    sessionId: string,
    options?: {
      includeSendMessageToolResults?: boolean;
    },
  ): SwarmdMessage[] {
    return this.db
      .prepare<{ session_id: string; include_send_message_tool_results: number }, MessageRow>(
        `SELECT
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
        FROM messages
        WHERE session_id = @session_id
          AND (
            role = 'assistant'
            OR (role = 'system' AND json_extract(metadata_json, '$.middleman.renderAs') IS NULL)
            OR (
              role IN ('user', 'system')
              AND json_extract(metadata_json, '$.middleman.renderAs') = 'conversation_message'
            )
            OR (
              role = 'system'
              AND json_extract(metadata_json, '$.middleman.renderAs') = 'conversation_log'
              AND json_extract(metadata_json, '$.middleman.event.isError') = 1
            )
            OR (
              role = 'system'
              AND json_extract(metadata_json, '$.middleman.renderAs') = 'hidden'
              AND json_extract(metadata_json, '$.middleman.visibility') = 'internal'
            )
            OR (
              role = 'tool'
              AND (
                json_extract(content_json, '$.toolName') = 'speak_to_user'
                OR (
                  @include_send_message_tool_results = 1
                  AND json_extract(content_json, '$.toolName') = 'send_message_to_agent'
                )
              )
            )
          )
        ORDER BY order_key ASC`,
      )
      .all({
        session_id: sessionId,
        include_send_message_tool_results: options?.includeSendMessageToolResults ? 1 : 0,
      })
      .map(mapMessageRow);
  }

  listManagerScopedHiddenMessages(managerId: string): SwarmdMessage[] {
    return this.db
      .prepare<{ manager_id: string }, MessageRow>(
        `SELECT
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
        FROM messages
        WHERE session_id <> @manager_id
          AND role = 'system'
          AND json_extract(metadata_json, '$.middleman.renderAs') = 'hidden'
          AND json_extract(metadata_json, '$.middleman.visibility') = 'internal'
          AND (
            json_extract(metadata_json, '$.middleman.routing.fromAgentId') = @manager_id
            OR json_extract(metadata_json, '$.middleman.routing.toAgentId') = @manager_id
          )
        ORDER BY order_key ASC`,
      )
      .all({ manager_id: managerId })
      .map(mapMessageRow);
  }

  updateMetadata(id: string, metadata: Record<string, unknown>): void {
    this.db
      .prepare<{ id: string; metadata_json: string }>(
        `UPDATE messages
        SET metadata_json = @metadata_json
        WHERE id = @id`,
      )
      .run({
        id,
        metadata_json: serializeJson(metadata),
      });
  }

  deleteBySession(sessionId: string): void {
    this.db
      .prepare<{ session_id: string }>("DELETE FROM messages WHERE session_id = @session_id")
      .run({ session_id: sessionId });
  }

  getLatestOrderKeyForTimestamp(sessionId: string, timestamp: string): string | null {
    const row = this.db
      .prepare<
        { session_id: string; start_order_key: string; end_order_key: string },
        { order_key: string }
      >(
        `SELECT order_key
        FROM messages
        WHERE session_id = @session_id
          AND order_key >= @start_order_key
          AND order_key < @end_order_key
        ORDER BY order_key DESC
        LIMIT 1`,
      )
      .get({
        session_id: sessionId,
        start_order_key: `${timestamp}-`,
        end_order_key: `${timestamp}-~`,
      });

    return row?.order_key ?? null;
  }
}
