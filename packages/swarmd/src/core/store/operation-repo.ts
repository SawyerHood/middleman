import type { Database } from "./db.js";
import { nowTimestamp, serializeJson } from "./shared.js";
import type { OperationRecord } from "../types/index.js";

interface OperationRow {
  id: string;
  session_id: string;
  type: string;
  status: OperationRecord["status"];
  result_json: string | null;
  error_json: string | null;
  created_at: string;
  completed_at: string | null;
}

function mapOperationRow(row: OperationRow): OperationRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    type: row.type,
    status: row.status,
    resultJson: row.result_json,
    errorJson: row.error_json,
    createdAt: row.created_at,
    completedAt: row.completed_at
  };
}

export class OperationRepo {
  constructor(private db: Database) {}

  create(op: OperationRecord): void {
    this.db
      .prepare<{
        id: string;
        session_id: string;
        type: string;
        status: OperationRecord["status"];
        result_json: string | null;
        error_json: string | null;
        created_at: string;
        completed_at: string | null;
      }>(`
        INSERT INTO operations (
          id,
          session_id,
          type,
          status,
          result_json,
          error_json,
          created_at,
          completed_at
        )
        VALUES (
          @id,
          @session_id,
          @type,
          @status,
          @result_json,
          @error_json,
          @created_at,
          @completed_at
        )
      `)
      .run({
        id: op.id,
        session_id: op.sessionId,
        type: op.type,
        status: op.status,
        result_json: op.resultJson,
        error_json: op.errorJson,
        created_at: op.createdAt,
        completed_at: op.completedAt
      });
  }

  getById(id: string): OperationRecord | null {
    const row = this.db
      .prepare<{ id: string }, OperationRow>(
        `SELECT
          id,
          session_id,
          type,
          status,
          result_json,
          error_json,
          created_at,
          completed_at
        FROM operations
        WHERE id = @id`
      )
      .get({ id });

    return row ? mapOperationRow(row) : null;
  }

  complete(id: string, result: unknown): void {
    this.db
      .prepare<{ id: string; result_json: string; completed_at: string }>(
        `UPDATE operations
        SET status = 'completed',
            result_json = @result_json,
            error_json = NULL,
            completed_at = @completed_at
        WHERE id = @id`
      )
      .run({
        id,
        result_json: serializeJson(result),
        completed_at: nowTimestamp()
      });
  }

  fail(id: string, error: unknown): void {
    this.db
      .prepare<{ id: string; error_json: string; completed_at: string }>(
        `UPDATE operations
        SET status = 'failed',
            result_json = NULL,
            error_json = @error_json,
            completed_at = @completed_at
        WHERE id = @id`
      )
      .run({
        id,
        error_json: serializeJson(error),
        completed_at: nowTimestamp()
      });
  }

  listBySession(sessionId: string): OperationRecord[] {
    return this.db
      .prepare<{ session_id: string }, OperationRow>(
        `SELECT
          id,
          session_id,
          type,
          status,
          result_json,
          error_json,
          created_at,
          completed_at
        FROM operations
        WHERE session_id = @session_id
        ORDER BY created_at ASC`
      )
      .all({ session_id: sessionId })
      .map(mapOperationRow);
  }

  deleteBySession(sessionId: string): void {
    this.db
      .prepare<{ session_id: string }>("DELETE FROM operations WHERE session_id = @session_id")
      .run({ session_id: sessionId });
  }
}
