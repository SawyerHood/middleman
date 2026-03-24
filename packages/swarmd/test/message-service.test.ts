import { afterEach, describe, expect, it, vi } from "vitest";

import {
  EventBus,
  MessageRepo,
  MessageService,
  MessageStore,
  OperationRepo,
  OperationService,
  SessionRepo,
  createDatabase,
  runMigrations,
  type Database,
  type RuntimeSupervisor,
  type SessionRecord,
  type SessionStatus,
  type WorkerCommand,
} from "../src/index.js";

interface SupervisorMock {
  activeSessions: Set<string>;
  hasWorker: ReturnType<typeof vi.fn<(sessionId: string) => boolean>>;
  sendCommand: ReturnType<typeof vi.fn<(sessionId: string, command: WorkerCommand) => void>>;
}

interface TestContext {
  messageService: MessageService;
  messageStore: MessageStore;
  operationService: OperationService;
  session: SessionRecord;
  supervisor: SupervisorMock;
}

function createSupervisorMock(): SupervisorMock {
  const activeSessions = new Set<string>();

  return {
    activeSessions,
    hasWorker: vi.fn((sessionId: string) => activeSessions.has(sessionId)),
    sendCommand: vi.fn((_: string, __: WorkerCommand) => undefined),
  };
}

function seedSession(sessionRepo: SessionRepo, status: SessionStatus): SessionRecord {
  const session: SessionRecord = {
    id: `session-${status}`,
    backend: "codex",
    status,
    displayName: "Message Service Test Session",
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
  return session;
}

function createTestContext(
  openDatabases: Database[],
  options?: {
    sessionStatus?: SessionStatus;
    workerRunning?: boolean;
  },
): TestContext {
  const db = createDatabase(":memory:");
  openDatabases.push(db);
  runMigrations(db);

  const sessionRepo = new SessionRepo(db);
  const messageRepo = new MessageRepo(db);
  const operationRepo = new OperationRepo(db);
  const eventBus = new EventBus();
  const messageStore = new MessageStore(sessionRepo, messageRepo);
  const operationService = new OperationService(operationRepo, eventBus);
  const supervisor = createSupervisorMock();
  const messageService = new MessageService(
    sessionRepo,
    supervisor as unknown as RuntimeSupervisor,
    operationService,
    messageStore,
  );
  const session = seedSession(sessionRepo, options?.sessionStatus ?? "idle");

  if (options?.workerRunning ?? true) {
    supervisor.activeSessions.add(session.id);
  }

  return {
    messageService,
    messageStore,
    operationService,
    session,
    supervisor,
  };
}

describe("MessageService", () => {
  const openDatabases: Database[] = [];

  afterEach(() => {
    vi.restoreAllMocks();

    while (openDatabases.length > 0) {
      openDatabases.pop()?.close();
    }
  });

  it("sends input through the supervisor and returns a receipt", () => {
    const { messageService, messageStore, operationService, session, supervisor } =
      createTestContext(openDatabases);

    const receipt = messageService.send(session.id, [{ type: "text", text: "hello swarmd" }], {
      metadata: { source: "cli" },
    });

    expect(receipt).toEqual({
      operationId: expect.stringMatching(/^[A-Za-z0-9_-]+$/),
      sessionId: session.id,
      acceptedDelivery: "auto",
      queued: false,
    });
    expect(supervisor.sendCommand).toHaveBeenCalledWith(session.id, {
      type: "send_input",
      input: {
        id: receipt.operationId,
        role: "user",
        parts: [{ type: "text", text: "hello swarmd" }],
        metadata: { source: "cli" },
      },
      delivery: "auto",
      operationId: receipt.operationId,
    });
    expect(operationService.getById(receipt.operationId)).toMatchObject({
      id: receipt.operationId,
      sessionId: session.id,
      type: "send_input",
      status: "pending",
    });
    expect(messageStore.list(session.id)).toEqual([
      expect.objectContaining({
        sessionId: session.id,
        source: "user",
        sourceMessageId: null,
        kind: "text",
        role: "user",
        content: {
          text: "hello swarmd",
          parts: [{ type: "text", text: "hello swarmd" }],
        },
        metadata: { source: "cli" },
      }),
    ]);
  });

  it("resolves auto delivery to queue for busy sessions and preserves explicit delivery requests", () => {
    const { messageService, messageStore, session, supervisor } = createTestContext(openDatabases, {
      sessionStatus: "busy",
    });

    const queuedReceipt = messageService.send(session.id, [{ type: "text", text: "queued" }]);
    const interruptReceipt = messageService.send(
      session.id,
      [{ type: "text", text: "interrupt now" }],
      {
        delivery: "interrupt",
        role: "system",
      },
    );

    expect(queuedReceipt.acceptedDelivery).toBe("queue");
    expect(queuedReceipt.queued).toBe(true);
    expect(interruptReceipt.acceptedDelivery).toBe("interrupt");
    expect(interruptReceipt.queued).toBe(false);

    expect(supervisor.sendCommand).toHaveBeenNthCalledWith(1, session.id, {
      type: "send_input",
      input: {
        id: queuedReceipt.operationId,
        role: "user",
        parts: [{ type: "text", text: "queued" }],
        metadata: undefined,
      },
      delivery: "queue",
      operationId: queuedReceipt.operationId,
    });
    expect(supervisor.sendCommand).toHaveBeenNthCalledWith(2, session.id, {
      type: "send_input",
      input: {
        id: interruptReceipt.operationId,
        role: "system",
        parts: [{ type: "text", text: "interrupt now" }],
        metadata: undefined,
      },
      delivery: "interrupt",
      operationId: interruptReceipt.operationId,
    });
    expect(messageStore.list(session.id).map((message) => message.role)).toEqual([
      "user",
      "system",
    ]);
  });

  it("sends interrupt commands through the supervisor and tracks the operation", () => {
    const { messageService, operationService, session, supervisor } =
      createTestContext(openDatabases);

    const operationId = messageService.interrupt(session.id);

    expect(operationId).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(supervisor.sendCommand).toHaveBeenCalledWith(session.id, {
      type: "interrupt",
      operationId,
    });
    expect(operationService.getById(operationId)).toMatchObject({
      id: operationId,
      sessionId: session.id,
      type: "interrupt",
      status: "pending",
    });
  });

  it("sends compact commands through the supervisor and tracks the operation", () => {
    const { messageService, operationService, session, supervisor } =
      createTestContext(openDatabases);

    const operationId = messageService.compact(session.id, "Keep recent tasks only");

    expect(operationId).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(supervisor.sendCommand).toHaveBeenCalledWith(session.id, {
      type: "compact",
      operationId,
      customInstructions: "Keep recent tasks only",
    });
    expect(operationService.getById(operationId)).toMatchObject({
      id: operationId,
      sessionId: session.id,
      type: "compact",
      status: "pending",
    });
  });

  it("rejects sends when the session is not running", () => {
    const { messageService, operationService, session, supervisor } = createTestContext(
      openDatabases,
      {
        sessionStatus: "stopped",
      },
    );

    expect(() => {
      messageService.send(session.id, [{ type: "text", text: "should fail" }]);
    }).toThrow(`Session ${session.id} is stopped, cannot send messages`);
    expect(supervisor.sendCommand).not.toHaveBeenCalled();
    expect(operationService.listBySession(session.id)).toEqual([]);
  });

  it("rejects commands when no worker is running for the session", () => {
    const { messageService, operationService, session, supervisor } = createTestContext(
      openDatabases,
      {
        workerRunning: false,
      },
    );

    expect(() => {
      messageService.send(session.id, [{ type: "text", text: "should fail" }]);
    }).toThrow(`No running worker for session ${session.id}`);
    expect(() => {
      messageService.interrupt(session.id);
    }).toThrow(`No running worker for session ${session.id}`);

    expect(supervisor.sendCommand).not.toHaveBeenCalled();
    expect(operationService.listBySession(session.id)).toEqual([]);
  });
});
