import { afterEach, describe, expect, it, vi } from "vitest";

import {
  EventBus,
  OperationRepo,
  OperationService,
  SessionRepo,
  createDatabase,
  runMigrations,
  type Database,
  type EventEnvelope,
  type SessionErrorInfo,
  type SessionRecord,
} from "../src/index.js";

interface TestContext {
  eventBus: EventBus;
  operationService: OperationService;
  session: SessionRecord;
}

function createTestContext(openDatabases: Database[]): TestContext {
  const db = createDatabase(":memory:");
  openDatabases.push(db);
  runMigrations(db);

  const sessionRepo = new SessionRepo(db);
  const operationRepo = new OperationRepo(db);
  const eventBus = new EventBus();

  const session: SessionRecord = {
    id: "session-1",
    backend: "codex",
    status: "created",
    displayName: "Primary Session",
    cwd: "/tmp/swarmd",
    model: "gpt-5",
    systemPrompt: "You are swarmd.",
    backendCheckpoint: null,
    createdAt: "2026-03-13T00:00:00.000Z",
    updatedAt: "2026-03-13T00:00:00.000Z",
    lastError: null,
    contextUsage: null,
  };

  sessionRepo.create(session);

  return {
    eventBus,
    operationService: new OperationService(operationRepo, eventBus),
    session,
  };
}

describe("OperationService", () => {
  const openDatabases: Database[] = [];

  afterEach(() => {
    vi.useRealTimers();

    while (openDatabases.length > 0) {
      openDatabases.pop()?.close();
    }
  });

  it("tracks operations and publishes completion events", () => {
    vi.useFakeTimers();

    const { eventBus, operationService, session } = createTestContext(openDatabases);
    const publishedEvents: EventEnvelope[] = [];

    eventBus.subscribe((event) => {
      publishedEvents.push(event);
    });

    vi.setSystemTime(new Date("2026-03-13T10:00:00.000Z"));

    const pendingOperation = operationService.create(session.id, "send_input");

    expect(pendingOperation).toEqual({
      id: expect.stringMatching(/^[A-Za-z0-9_-]+$/),
      sessionId: session.id,
      type: "send_input",
      status: "pending",
      resultJson: null,
      errorJson: null,
      createdAt: "2026-03-13T10:00:00.000Z",
      completedAt: null,
    });
    expect(operationService.getById(pendingOperation.id)).toEqual(pendingOperation);

    vi.setSystemTime(new Date("2026-03-13T10:00:05.000Z"));

    const completedResult = { accepted: true, queued: false };
    const completedOperation = operationService.complete(pendingOperation.id, completedResult);

    expect(completedOperation).toEqual({
      ...pendingOperation,
      status: "completed",
      resultJson: JSON.stringify(completedResult),
      errorJson: null,
      completedAt: "2026-03-13T10:00:05.000Z",
    });
    expect(publishedEvents).toEqual([
      {
        id: expect.stringMatching(/^[A-Za-z0-9_-]+$/),
        cursor: null,
        sessionId: session.id,
        threadId: null,
        timestamp: "2026-03-13T10:00:05.000Z",
        source: "server",
        type: "operation.completed",
        payload: {
          operationId: pendingOperation.id,
          status: "completed",
          result: completedResult,
        },
      },
    ]);

    vi.setSystemTime(new Date("2026-03-13T10:01:00.000Z"));

    const failedOperation = operationService.create(session.id, "interrupt");
    const error: SessionErrorInfo = {
      code: "busy",
      message: "Session is still processing a prior command",
      retryable: true,
      details: { activeOperationId: pendingOperation.id },
    };

    vi.setSystemTime(new Date("2026-03-13T10:01:05.000Z"));

    const storedFailure = operationService.fail(failedOperation.id, error);

    expect(storedFailure).toEqual({
      ...failedOperation,
      status: "failed",
      resultJson: null,
      errorJson: JSON.stringify(error),
      completedAt: "2026-03-13T10:01:05.000Z",
    });

    expect(publishedEvents[1]).toMatchObject({
      id: expect.stringMatching(/^[A-Za-z0-9_-]+$/),
      cursor: null,
      sessionId: session.id,
      threadId: null,
      timestamp: "2026-03-13T10:01:05.000Z",
      source: "server",
      type: "operation.completed",
      payload: {
        operationId: failedOperation.id,
        status: "failed",
        error,
      },
    });
    expect(operationService.listBySession(session.id)).toEqual([completedOperation, storedFailure]);
  });
});
