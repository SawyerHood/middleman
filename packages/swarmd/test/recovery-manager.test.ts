import { afterEach, describe, expect, it, vi } from "vitest";

import {
  EventBus,
  MessageRepo,
  OperationRepo,
  OperationService,
  RecoveryManager,
  SessionBackendStateRepo,
  SessionRepo,
  SessionService,
  createDatabase,
  runMigrations,
  type Database,
  type RuntimeSupervisor,
  type SessionRecord,
  type SessionRuntimeConfig,
  type SessionStatus,
} from "../src/index.js";

interface SupervisorMock {
  spawnWorker: ReturnType<typeof vi.fn>;
  hasWorker: ReturnType<typeof vi.fn<(sessionId: string) => boolean>>;
  stopWorker: ReturnType<typeof vi.fn>;
  terminateWorker: ReturnType<typeof vi.fn>;
}

interface RecoveryTestContext {
  db: Database;
  recoveryManager: RecoveryManager;
  sessionRepo: SessionRepo;
  supervisor: SupervisorMock;
}

function createSupervisorMock(failingSessionId?: string): SupervisorMock {
  return {
    spawnWorker: vi.fn(async (session: SessionRecord, _config: SessionRuntimeConfig) => {
      if (session.id === failingSessionId) {
        throw new Error(`spawn failed for ${session.id}`);
      }

      return undefined as never;
    }),
    hasWorker: vi.fn((_sessionId: string) => false),
    stopWorker: vi.fn(async (_sessionId: string, _operationId: string) => undefined),
    terminateWorker: vi.fn(async (_sessionId: string, _operationId: string) => undefined),
  };
}

function createSessionRecord(id: string, status: SessionStatus, index: number): SessionRecord {
  const timestamp = new Date(Date.UTC(2026, 2, 13, 0, index, 0)).toISOString();

  return {
    id,
    backend: "codex",
    status,
    displayName: `Session ${id}`,
    cwd: "/tmp/swarmd-recovery",
    model: "codex",
    metadata: {},
    backendCheckpoint: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    lastError: null,
    contextUsage: null,
  };
}

function seedSession(
  sessionRepo: SessionRepo,
  id: string,
  status: SessionStatus,
  index: number,
): SessionRecord {
  const session = createSessionRecord(id, status, index);
  sessionRepo.create(session);
  return session;
}

function createTestContext(failingSessionId?: string): RecoveryTestContext {
  const db = createDatabase(":memory:");
  runMigrations(db);

  const sessionRepo = new SessionRepo(db);
  const messageRepo = new MessageRepo(db);
  const sessionBackendStateRepo = new SessionBackendStateRepo(db);
  const operationRepo = new OperationRepo(db);
  const eventBus = new EventBus();
  const operationService = new OperationService(operationRepo, eventBus);
  const supervisor = createSupervisorMock(failingSessionId);
  const sessionService = new SessionService(
    sessionRepo,
    messageRepo,
    operationRepo,
    sessionBackendStateRepo,
    supervisor as unknown as RuntimeSupervisor,
    eventBus,
    operationService,
  );
  const recoveryManager = new RecoveryManager({
    sessionRepo,
    sessionService,
  });

  return {
    db,
    recoveryManager,
    sessionRepo,
    supervisor,
  };
}

describe("RecoveryManager", () => {
  const openDatabases: Database[] = [];

  afterEach(() => {
    vi.restoreAllMocks();

    while (openDatabases.length > 0) {
      openDatabases.pop()?.close();
    }
  });

  it("recovers only sessions that were previously running and marks failed restarts as errored", async () => {
    const context = createTestContext("busy-fail");
    openDatabases.push(context.db);

    seedSession(context.sessionRepo, "starting", "starting", 0);
    seedSession(context.sessionRepo, "idle", "idle", 1);
    seedSession(context.sessionRepo, "busy-fail", "busy", 2);
    seedSession(context.sessionRepo, "interrupting", "interrupting", 3);
    seedSession(context.sessionRepo, "stopped", "stopped", 4);
    seedSession(context.sessionRepo, "terminated", "terminated", 5);

    const stoppedBefore = context.sessionRepo.getById("stopped");
    const terminatedBefore = context.sessionRepo.getById("terminated");

    const result = await context.recoveryManager.recover();

    expect(result).toEqual({
      attempted: 4,
      recovered: 3,
      failed: 1,
      results: [
        { sessionId: "starting", status: "recovered" },
        { sessionId: "idle", status: "recovered" },
        {
          sessionId: "busy-fail",
          status: "failed",
          error: "spawn failed for busy-fail",
        },
        { sessionId: "interrupting", status: "recovered" },
      ],
    });

    expect(context.supervisor.spawnWorker).toHaveBeenCalledTimes(4);
    expect(context.supervisor.spawnWorker.mock.calls.map(([session]) => session.id)).toEqual([
      "starting",
      "idle",
      "busy-fail",
      "interrupting",
    ]);

    expect(context.sessionRepo.getById("starting")?.status).toBe("idle");
    expect(context.sessionRepo.getById("idle")?.status).toBe("idle");
    expect(context.sessionRepo.getById("interrupting")?.status).toBe("idle");
    expect(context.sessionRepo.getById("busy-fail")).toMatchObject({
      status: "errored",
      lastError: {
        code: "RECOVERY_FAILED",
        message: "spawn failed for busy-fail",
        retryable: true,
      },
    });

    expect(context.sessionRepo.getById("stopped")).toEqual(stoppedBefore);
    expect(context.sessionRepo.getById("terminated")).toEqual(terminatedBefore);
  });
});
