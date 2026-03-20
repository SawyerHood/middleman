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
});
