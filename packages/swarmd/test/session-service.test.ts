import { afterEach, describe, expect, it, vi } from "vitest";

import {
  EventBus,
  MessageRepo,
  OperationRepo,
  OperationService,
  SessionBackendStateRepo,
  SessionRepo,
  SessionService,
  createDatabase,
  runMigrations,
  type BackendCheckpoint,
  type Database,
  type EventEnvelope,
  type RuntimeSupervisor,
  type SessionRuntimeConfig,
  type SessionRecord,
} from "../src/index.js";

interface SupervisorMock {
  activeSessions: Set<string>;
  hasWorker: ReturnType<typeof vi.fn<(sessionId: string) => boolean>>;
  spawnWorker: ReturnType<typeof vi.fn>;
  stopWorker: ReturnType<typeof vi.fn>;
  terminateWorker: ReturnType<typeof vi.fn>;
}

interface TestContext {
  events: EventEnvelope[];
  operationService: OperationService;
  sessionRepo: SessionRepo;
  sessionService: SessionService;
  supervisor: SupervisorMock;
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;

  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return { promise, resolve, reject };
}

function createSupervisorMock(): SupervisorMock {
  const activeSessions = new Set<string>();

  return {
    activeSessions,
    hasWorker: vi.fn((sessionId: string) => activeSessions.has(sessionId)),
    spawnWorker: vi.fn(async (session: SessionRecord, _config: SessionRuntimeConfig) => {
      activeSessions.add(session.id);
      return undefined as never;
    }),
    stopWorker: vi.fn(async (sessionId: string, _operationId: string) => {
      activeSessions.delete(sessionId);
    }),
    terminateWorker: vi.fn(async (sessionId: string, _operationId: string) => {
      activeSessions.delete(sessionId);
    }),
  };
}

function createTestContext(openDatabases: Database[]): TestContext {
  const db = createDatabase(":memory:");
  openDatabases.push(db);
  runMigrations(db);

  const sessionRepo = new SessionRepo(db);
  const messageRepo = new MessageRepo(db);
  const sessionBackendStateRepo = new SessionBackendStateRepo(db);
  const operationRepo = new OperationRepo(db);
  const eventBus = new EventBus();
  const operationService = new OperationService(operationRepo, eventBus);
  const supervisor = createSupervisorMock();
  const sessionService = new SessionService(
    sessionRepo,
    messageRepo,
    operationRepo,
    sessionBackendStateRepo,
    supervisor as unknown as RuntimeSupervisor,
    eventBus,
    operationService,
  );
  const events: EventEnvelope[] = [];

  eventBus.subscribe((event) => {
    events.push(event);
  });

  return {
    events,
    operationService,
    sessionRepo,
    sessionService,
    supervisor,
  };
}

describe("SessionService", () => {
  const openDatabases: Database[] = [];

  afterEach(() => {
    vi.restoreAllMocks();

    while (openDatabases.length > 0) {
      openDatabases.pop()?.close();
    }
  });

  it("creates a session and emits session.created", () => {
    const { events, sessionService } = createTestContext(openDatabases);

    const session = sessionService.create({
      backend: "codex",
      cwd: "/tmp/swarmd",
      displayName: "Primary Session",
      metadata: { owner: "manager" },
    });

    expect(session).toEqual({
      id: expect.stringMatching(/^[A-Za-z0-9_-]+$/),
      backend: "codex",
      status: "created",
      displayName: "Primary Session",
      cwd: "/tmp/swarmd",
      model: "",
      systemPrompt: undefined,
      metadata: { owner: "manager" },
      backendCheckpoint: null,
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
      lastError: null,
      contextUsage: null,
    });

    expect(events[0]).toMatchObject({
      id: expect.stringMatching(/^[A-Za-z0-9_-]+$/),
      sessionId: session.id,
      threadId: null,
      source: "server",
      type: "session.created",
      payload: {
        session,
      },
    });
  });

  it("uses caller-provided ids and updates metadata, display names, and checkpoints", () => {
    const { sessionService } = createTestContext(openDatabases);
    const session = sessionService.create({
      id: "my-agent",
      backend: "claude",
      cwd: "/tmp/swarmd",
      metadata: { owner: "manager" },
    });

    const checkpoint: BackendCheckpoint = {
      backend: "claude",
      sessionId: "claude-session-1",
      resumeAtMessageId: "msg_123",
    };

    const metadataUpdated = sessionService.updateMetadata(session.id, {
      owner: "operator",
      priority: "high",
    });
    const renamed = sessionService.updateDisplayName(session.id, "Renamed Session");
    const checkpointUpdated = sessionService.updateCheckpoint(session.id, checkpoint);

    expect(session.id).toBe("my-agent");
    expect(metadataUpdated.metadata).toEqual({
      owner: "operator",
      priority: "high",
    });
    expect(renamed.displayName).toBe("Renamed Session");
    expect(checkpointUpdated.backendCheckpoint).toEqual(checkpoint);
  });

  it("persists runtime errors and context usage when a worker reports runtime status", () => {
    const { sessionRepo, sessionService } = createTestContext(openDatabases);
    const session = sessionService.create({
      backend: "claude",
      cwd: "/tmp/swarmd",
    });

    const updated = sessionService.applyRuntimeStatus(session.id, "errored", {
      code: "CLAUDE_QUERY_FAILED",
      message: "Missing authentication for claude-code.",
      retryable: true,
    }, {
      tokens: 42_000,
      contextWindow: 200_000,
      percent: 21,
    });

    expect(updated.status).toBe("errored");
    expect(updated.lastError).toEqual({
      code: "CLAUDE_QUERY_FAILED",
      message: "Missing authentication for claude-code.",
      retryable: true,
    });
    expect(updated.contextUsage).toEqual({
      tokens: 42_000,
      contextWindow: 200_000,
      percent: 21,
    });
    expect(sessionRepo.getById(session.id)?.lastError).toEqual(updated.lastError);
    expect(sessionRepo.getById(session.id)?.contextUsage).toEqual(updated.contextUsage);
  });

  it("archives sessions without deleting them and excludes them from default listings", () => {
    const { sessionService } = createTestContext(openDatabases);
    const session = sessionService.create({
      backend: "codex",
      cwd: "/tmp/swarmd",
    });

    sessionService.archiveSession(session.id);

    expect(sessionService.getById(session.id)?.id).toBe(session.id);
    expect(sessionService.list()).toEqual([]);
    expect(sessionService.list({ includeArchived: true }).map((entry) => entry.id)).toEqual([
      session.id,
    ]);
    expect(() => sessionService.requestStart(session.id)).toThrow(
      `Cannot start archived session ${session.id}`,
    );
  });

  it("transitions from created to starting to idle when the worker starts", async () => {
    const { events, sessionRepo, sessionService, supervisor } = createTestContext(openDatabases);
    const session = sessionService.create({
      backend: "codex",
      cwd: "/tmp/swarmd",
      backendConfig: {
        command: "codex",
        experimentalRawEvents: true,
      },
    });

    const spawn = createDeferred<void>();
    let capturedConfig: SessionRuntimeConfig | undefined;

    supervisor.spawnWorker.mockImplementationOnce(async (spawnSession: SessionRecord, config: SessionRuntimeConfig) => {
      supervisor.activeSessions.add(spawnSession.id);
      capturedConfig = config;
      await spawn.promise;
      return undefined as never;
    });

    const startPromise = sessionService.start(session.id);

    expect(sessionRepo.getById(session.id)?.status).toBe("starting");
    expect(events.at(-1)).toMatchObject({
      type: "session.status.changed",
      payload: {
        status: "starting",
        previousStatus: "created",
      },
    });

    spawn.resolve();
    await startPromise;

    expect(sessionRepo.getById(session.id)?.status).toBe("idle");
    expect(capturedConfig).toEqual({
      backend: "codex",
      cwd: "/tmp/swarmd",
      model: "",
      backendConfig: {
        command: "codex",
        experimentalRawEvents: true,
      },
    });
    expect(events.slice(-2)).toEqual([
      expect.objectContaining({
        type: "session.status.changed",
        payload: {
          status: "idle",
          previousStatus: "starting",
        },
      }),
      expect.objectContaining({
        type: "session.started",
        threadId: null,
        payload: {
          status: "idle",
        },
      }),
    ]);
  });

  it("stops sessions through the supervisor and completes the stop operation", async () => {
    const { operationService, sessionRepo, sessionService, supervisor } = createTestContext(openDatabases);
    const session = sessionService.create({
      backend: "codex",
      cwd: "/tmp/swarmd",
    });

    supervisor.activeSessions.add(session.id);

    await sessionService.stop(session.id);

    const [operation] = operationService.listBySession(session.id);
    expect(operation).toMatchObject({
      sessionId: session.id,
      type: "stop",
      status: "completed",
    });
    expect(sessionRepo.getById(session.id)?.status).toBe("stopped");
    expect(supervisor.stopWorker).toHaveBeenCalledWith(
      session.id,
      expect.stringMatching(/^[A-Za-z0-9_-]+$/),
    );
  });

  it("resets stored session state without exposing raw table mutations", () => {
    const { events, operationService, sessionRepo, sessionService } = createTestContext(openDatabases);
    const session = sessionService.create({
      backend: "codex",
      cwd: "/tmp/swarmd",
      systemPrompt: "before",
      backendConfig: { foo: "bar" },
    });

    operationService.create(session.id, "send_input");
    sessionService.updateBackendState(session.id, { thread: "abc" });

    const reset = sessionService.reset(session.id, {
      systemPrompt: "after",
      runtimeConfig: {
        backendConfig: { baz: "qux" },
      },
      updatedAt: "2026-03-14T00:00:00.000Z",
    });

    expect(reset).toMatchObject({
      id: session.id,
      status: "stopped",
      systemPrompt: "after",
      backendCheckpoint: null,
      lastError: null,
      contextUsage: null,
      updatedAt: "2026-03-14T00:00:00.000Z",
    });
    expect(operationService.listBySession(session.id)).toEqual([]);
    expect(sessionRepo.getRuntimeConfig(session.id)).toEqual({
      backendConfig: { baz: "qux" },
    });
    expect(sessionService.getBackendState(session.id)).toBeNull();
    expect(events.at(-1)).toMatchObject({
      type: "session.reset",
      sessionId: session.id,
    });
  });

  it("preserves an existing startup error when the worker exits after failing to boot", () => {
    const { events, sessionRepo, sessionService } = createTestContext(openDatabases);
    const session = sessionService.create({
      backend: "pi",
      cwd: "/tmp/swarmd",
    });

    sessionService.handleWorkerError(
      session.id,
      new Error("Pi backend requires @mariozechner/pi-coding-agent to be installed."),
    );
    sessionService.handleWorkerExit(session.id, 1, null);

    expect(sessionRepo.getById(session.id)?.status).toBe("errored");
    expect(sessionRepo.getById(session.id)?.lastError).toEqual({
      code: "WORKER_ERROR",
      message: "Pi backend requires @mariozechner/pi-coding-agent to be installed.",
      retryable: true,
    });
    expect(events.at(-1)).toMatchObject({
      type: "session.errored",
      payload: {
        error: {
          message: "Pi backend requires @mariozechner/pi-coding-agent to be installed.",
        },
      },
    });
  });

  it("treats SIGINT and SIGTERM worker exits as clean shutdowns", () => {
    const { events, sessionRepo, sessionService } = createTestContext(openDatabases);
    const session = sessionService.create({
      backend: "codex",
      cwd: "/tmp/swarmd",
    });

    sessionService.applyRuntimeStatus(session.id, "busy");
    sessionService.handleWorkerExit(session.id, null, "SIGINT");

    expect(sessionRepo.getById(session.id)?.status).toBe("stopped");
    expect(sessionRepo.getById(session.id)?.lastError).toBeNull();
    expect(events.at(-1)).toMatchObject({
      type: "session.stopped",
      payload: {
        code: null,
        signal: "SIGINT",
      },
    });

    sessionService.applyRuntimeStatus(session.id, "busy");
    sessionService.handleWorkerExit(session.id, null, "SIGTERM");

    expect(sessionRepo.getById(session.id)?.status).toBe("stopped");
    expect(sessionRepo.getById(session.id)?.lastError).toBeNull();
    expect(events.at(-1)).toMatchObject({
      type: "session.stopped",
      payload: {
        code: null,
        signal: "SIGTERM",
      },
    });
  });

  it("clears stale expected-shutdown worker errors during reconcile", () => {
    const { sessionRepo, sessionService } = createTestContext(openDatabases);
    const session = sessionService.create({
      backend: "codex",
      cwd: "/tmp/swarmd",
    });

    sessionService.applyRuntimeStatus(session.id, "errored", {
      code: "WORKER_CRASHED",
      message: "Worker exited with code null, signal SIGINT",
      retryable: true,
    });

    const reconciled = sessionService.reconcilePersistedSessions();

    expect(reconciled).toEqual([
      expect.objectContaining({
        id: session.id,
        status: "stopped",
        lastError: null,
      }),
    ]);
    expect(sessionRepo.getById(session.id)?.status).toBe("stopped");
    expect(sessionRepo.getById(session.id)?.lastError).toBeNull();
  });

  it("only deletes sessions when no worker is running", () => {
    const { sessionRepo, sessionService, supervisor } = createTestContext(openDatabases);
    const session = sessionService.create({
      backend: "pi",
      cwd: "/tmp/swarmd",
    });

    supervisor.activeSessions.add(session.id);

    expect(() => sessionService.delete(session.id)).toThrow(
      "Cannot delete a running session. Stop or terminate it first.",
    );

    supervisor.activeSessions.delete(session.id);
    sessionService.delete(session.id);

    expect(sessionRepo.getById(session.id)).toBeNull();
  });
});
