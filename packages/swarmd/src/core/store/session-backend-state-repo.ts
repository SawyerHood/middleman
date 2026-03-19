import type { Database } from "./db.js";
import { nowTimestamp, parseJsonObject, serializeJson } from "./shared.js";
import type { BackendKind } from "../types/index.js";

interface SessionBackendStateRow {
  session_id: string;
  backend: BackendKind;
  state_json: string;
  updated_at: string;
}

export interface SessionBackendStateRecord {
  sessionId: string;
  backend: BackendKind;
  state: Record<string, unknown>;
  updatedAt: string;
}

function mapSessionBackendStateRow(row: SessionBackendStateRow): SessionBackendStateRecord {
  return {
    sessionId: row.session_id,
    backend: row.backend,
    state: parseJsonObject(row.state_json, "state_json"),
    updatedAt: row.updated_at,
  };
}

export class SessionBackendStateRepo {
  constructor(private db: Database) {}

  getBySessionId(sessionId: string): SessionBackendStateRecord | null {
    const row = this.db
      .prepare<{ sessionId: string }, SessionBackendStateRow>(
        `SELECT session_id, backend, state_json, updated_at
         FROM session_backend_state
         WHERE session_id = @sessionId`,
      )
      .get({ sessionId });

    return row ? mapSessionBackendStateRow(row) : null;
  }

  upsert(sessionId: string, backend: BackendKind, state: Record<string, unknown>): void {
    this.db
      .prepare<{
        session_id: string;
        backend: BackendKind;
        state_json: string;
        updated_at: string;
      }>(
        `INSERT INTO session_backend_state (session_id, backend, state_json, updated_at)
         VALUES (@session_id, @backend, @state_json, @updated_at)
         ON CONFLICT(session_id) DO UPDATE SET
           backend = excluded.backend,
           state_json = excluded.state_json,
           updated_at = excluded.updated_at`,
      )
      .run({
        session_id: sessionId,
        backend,
        state_json: serializeJson(state),
        updated_at: nowTimestamp(),
      });
  }

  delete(sessionId: string): void {
    this.db
      .prepare<{
        sessionId: string;
      }>("DELETE FROM session_backend_state WHERE session_id = @sessionId")
      .run({ sessionId });
  }
}
