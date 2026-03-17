import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { createConfig } from "../config.js";
import { SwarmManager } from "../swarm/swarm-manager.js";
import {
  MIDDLEMAN_STORE_MIGRATIONS,
  MiddlemanAgentRepo,
  MiddlemanManagerOrderRepo,
  MiddlemanScheduleRepo,
  MiddlemanSettingsRepo,
} from "../swarm/swarm-sql.js";
import {
  EventBus,
  MessageCapture,
  MessageRepo,
  MessageService,
  MessageStore,
  OperationRepo,
  OperationService,
  SessionBackendStateRepo,
  SessionRepo,
  SessionService,
  createDatabase,
  messageCompletedEvent,
  messageStartedEvent,
  runMigrations,
  type SessionRecord,
  type SessionRuntimeConfig,
  type SwarmdCoreHandle,
  type WorkerCommand,
} from "swarmd";

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const DEFAULT_MODEL = "gpt-5.4";

interface SupervisorMock {
  activeSessions: Set<string>;
  sentCommands: Array<{ sessionId: string; command: WorkerCommand }>;
  spawnCalls: string[];
  hasWorker(sessionId: string): boolean;
  sendCommand(sessionId: string, command: WorkerCommand): void;
  shutdownAll(): Promise<void>;
  spawnWorker(
    session: SessionRecord,
    config: SessionRuntimeConfig,
  ): Promise<unknown>;
  stopWorker(sessionId: string): Promise<void>;
  terminateWorker(sessionId: string): Promise<void>;
}

interface Harness {
  close(): Promise<void>;
  core: SwarmdCoreHandle;
  eventBus: EventBus;
  manager: SwarmManager;
  messageCapture: MessageCapture;
  sessionService: SessionService;
  supervisor: SupervisorMock;
  addAgent(input: {
    agentId: string;
    managerId: string;
    role: "manager" | "worker";
    status: SessionRecord["status"];
  }): Promise<void>;
}

function createSupervisorMock(): SupervisorMock {
  const activeSessions = new Set<string>();
  const sentCommands: Array<{ sessionId: string; command: WorkerCommand }> = [];
  const spawnCalls: string[] = [];

  return {
    activeSessions,
    sentCommands,
    spawnCalls,
    hasWorker(sessionId: string) {
      return activeSessions.has(sessionId);
    },
    sendCommand(sessionId: string, command: WorkerCommand) {
      sentCommands.push({ sessionId, command });
    },
    async shutdownAll() {
      activeSessions.clear();
    },
    async spawnWorker(session: SessionRecord, _config: SessionRuntimeConfig) {
      activeSessions.add(session.id);
      spawnCalls.push(session.id);
      return {
        sessionId: session.id,
      };
    },
    async stopWorker(sessionId: string) {
      activeSessions.delete(sessionId);
    },
    async terminateWorker(sessionId: string) {
      activeSessions.delete(sessionId);
    },
  };
}

async function createHarness(): Promise<Harness> {
  const dataDir = await mkdtemp(resolve(tmpdir(), "middleman-completion-report-"));
  const manager = new SwarmManager(
    createConfig({
      installDir: REPO_ROOT,
      projectRoot: REPO_ROOT,
      dataDir,
    }),
  );

  const db = createDatabase(":memory:");
  runMigrations(db, { migrations: MIDDLEMAN_STORE_MIGRATIONS });

  const agentRepo = new MiddlemanAgentRepo(db);
  const managerOrderRepo = new MiddlemanManagerOrderRepo(db);
  const scheduleRepo = new MiddlemanScheduleRepo(db);
  const settingsRepo = new MiddlemanSettingsRepo(db);
  const sessionRepo = new SessionRepo(db);
  const messageRepo = new MessageRepo(db);
  const operationRepo = new OperationRepo(db);
  const sessionBackendStateRepo = new SessionBackendStateRepo(db);
  const eventBus = new EventBus();
  const supervisor = createSupervisorMock();
  const messageStore = new MessageStore(sessionRepo, messageRepo);
  const messageCapture = new MessageCapture(eventBus, messageStore);
  const operationService = new OperationService(operationRepo, eventBus);
  const sessionService = new SessionService(
    sessionRepo,
    messageRepo,
    operationRepo,
    sessionBackendStateRepo,
    supervisor as never,
    eventBus,
    operationService,
  );
  const messageService = new MessageService(
    sessionRepo,
    supervisor as never,
    operationService,
    messageStore,
  );

  const core = {
    config: { dataDir, dbPath: ":memory:", logLevel: "error" },
    db,
    supervisor: supervisor as never,
    sessionService,
    messageService,
    messageStore,
    operationService,
    eventBus,
    recoveryManager: {
      async recover() {
        return { attempted: 0, recovered: 0, failed: 0, results: [] };
      },
    },
    archiveSession(sessionId: string) {
      sessionService.archiveSession(sessionId);
    },
    async shutdown() {
      await supervisor.shutdownAll();
      db.close();
    },
  } as unknown as SwarmdCoreHandle;

  Object.assign(manager as object, {
    core,
    agentRepo,
    managerOrderRepo,
    scheduleRepo,
    settingsRepo,
  });
  (manager as any).installCoreEventProjection();

  return {
    async close() {
      messageCapture.dispose();
      await rm(dataDir, { recursive: true, force: true });
      db.close();
    },
    core,
    eventBus,
    manager,
    messageCapture,
    sessionService,
    supervisor,
    async addAgent(input) {
      sessionService.create({
        id: input.agentId,
        backend: "codex",
        cwd: REPO_ROOT,
        model: DEFAULT_MODEL,
        displayName: input.agentId,
        systemPrompt: `${input.role} prompt`,
      });
      agentRepo.create({
        sessionId: input.agentId,
        role: input.role,
        managerSessionId: input.managerId,
        archetypeId: input.role === "manager" ? "manager" : undefined,
        memoryOwnerSessionId: input.managerId,
      });

      if (input.role === "manager") {
        managerOrderRepo.ensure([input.agentId]);
      }

      if (
        input.status === "starting" ||
        input.status === "idle" ||
        input.status === "busy" ||
        input.status === "interrupting" ||
        input.status === "stopping"
      ) {
        supervisor.activeSessions.add(input.agentId);
      }

      if (input.status !== "created") {
        sessionService.applyRuntimeStatus(input.agentId, input.status);
      }
    },
  };
}

function publishAssistantCompletion(
  harness: Harness,
  agentId: string,
  input: { messageId: string; text?: string; includeStarted?: boolean },
): void {
  if (input.includeStarted) {
    harness.eventBus.publish({
      ...messageStartedEvent({
        sessionId: agentId,
        threadId: null,
        source: "backend",
        messageId: input.messageId,
        role: "assistant",
      }),
      cursor: null,
    });
  }

  harness.eventBus.publish({
    ...messageCompletedEvent({
      sessionId: agentId,
      threadId: null,
      source: "backend",
      messageId: input.messageId,
      payload: input.text === undefined ? undefined : { text: input.text },
    }),
    cursor: null,
  });
}

function publishAssistantCompletionWithoutSummary(
  harness: Harness,
  agentId: string,
  messageId: string,
): void {
  harness.eventBus.publish({
    ...messageCompletedEvent({
      sessionId: agentId,
      threadId: null,
      source: "backend",
      messageId,
      payload: {
        role: "assistant",
      },
    }),
    cursor: null,
  });
}

function managerReportTexts(manager: SwarmManager, managerId: string): string[] {
  return manager
    .getVisibleTranscript(managerId)
    .filter((entry) => entry.type === "agent_message")
    .map((entry) => entry.text);
}

async function waitForCondition(
  predicate: () => boolean,
  timeoutMs = 1_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }

    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 0);
      timer.unref?.();
    });
  }

  throw new Error(`Timed out after ${timeoutMs}ms waiting for condition.`);
}

async function flushAsyncWork(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("SwarmManager worker completion reports", () => {
  const harnesses: Harness[] = [];

  afterEach(async () => {
    while (harnesses.length > 0) {
      await harnesses.pop()?.close();
    }
  });

  it("sends a summary to the manager for codex-style assistant completions without payload role", async () => {
    const harness = await createHarness();
    harnesses.push(harness);

    await harness.addAgent({
      agentId: "manager-1",
      managerId: "manager-1",
      role: "manager",
      status: "idle",
    });
    await harness.addAgent({
      agentId: "worker-1",
      managerId: "manager-1",
      role: "worker",
      status: "busy",
    });

    publishAssistantCompletion(harness, "worker-1", {
      messageId: "msg-1",
      text: "Investigated the failing build and updated the migration.",
      includeStarted: true,
    });
    harness.sessionService.applyRuntimeStatus("worker-1", "idle");

    await waitForCondition(
      () => managerReportTexts(harness.manager, "manager-1").length === 1,
    );

    expect(managerReportTexts(harness.manager, "manager-1")).toEqual([
      [
        "SYSTEM: Worker worker-1 completed its turn.",
        "",
        "Last assistant message:",
        "Investigated the failing build and updated the migration.",
      ].join("\n"),
    ]);
  });

  it("does not send a completion report for a worker without a manager", async () => {
    const harness = await createHarness();
    harnesses.push(harness);

    harness.sessionService.create({
      id: "missing-manager",
      backend: "codex",
      cwd: REPO_ROOT,
      model: DEFAULT_MODEL,
      displayName: "missing-manager",
      systemPrompt: "manager prompt",
    });
    harness.sessionService.applyRuntimeStatus("missing-manager", "stopped");
    await harness.addAgent({
      agentId: "orphan-worker",
      managerId: "missing-manager",
      role: "worker",
      status: "busy",
    });

    publishAssistantCompletion(harness, "orphan-worker", {
      messageId: "msg-1",
      text: "Finished the standalone task.",
      includeStarted: true,
    });
    harness.sessionService.applyRuntimeStatus("orphan-worker", "idle");

    await flushAsyncWork();

    expect(harness.supervisor.sentCommands).toEqual([]);
    expect(
      (harness.manager as any).pendingWorkerCompletionReportAgentIds.has(
        "orphan-worker",
      ),
    ).toBe(false);
  });

  it("reports worker runtime errors to the manager", async () => {
    const harness = await createHarness();
    harnesses.push(harness);

    await harness.addAgent({
      agentId: "manager-1",
      managerId: "manager-1",
      role: "manager",
      status: "idle",
    });
    await harness.addAgent({
      agentId: "worker-1",
      managerId: "manager-1",
      role: "worker",
      status: "busy",
    });

    harness.sessionService.reportRuntimeError("worker-1", {
      code: "WORKER_ERROR",
      message: "Missing authentication for anthropic. Configure credentials in Settings.",
      retryable: false,
    });

    await waitForCondition(
      () => managerReportTexts(harness.manager, "manager-1").length === 1,
    );

    expect(managerReportTexts(harness.manager, "manager-1")).toEqual([
      "SYSTEM: Worker worker-1 errored: Missing authentication for anthropic. Configure credentials in Settings.",
    ]);
  });

  it("does not repeat the last summary content after a worker restarts without new output", async () => {
    const harness = await createHarness();
    harnesses.push(harness);

    await harness.addAgent({
      agentId: "manager-1",
      managerId: "manager-1",
      role: "manager",
      status: "idle",
    });
    await harness.addAgent({
      agentId: "worker-1",
      managerId: "manager-1",
      role: "worker",
      status: "busy",
    });

    publishAssistantCompletion(harness, "worker-1", {
      messageId: "msg-1",
      text: "Implemented the completion hook.",
      includeStarted: true,
    });
    harness.sessionService.applyRuntimeStatus("worker-1", "idle");
    await waitForCondition(
      () => managerReportTexts(harness.manager, "manager-1").length === 1,
    );

    harness.sessionService.applyRuntimeStatus("worker-1", "busy");
    publishAssistantCompletionWithoutSummary(harness, "worker-1", "msg-2");
    harness.sessionService.applyRuntimeStatus("worker-1", "idle");

    await waitForCondition(
      () => managerReportTexts(harness.manager, "manager-1").length === 2,
    );

    expect(managerReportTexts(harness.manager, "manager-1")).toEqual([
      [
        "SYSTEM: Worker worker-1 completed its turn.",
        "",
        "Last assistant message:",
        "Implemented the completion hook.",
      ].join("\n"),
      "SYSTEM: Worker worker-1 completed its turn.",
    ]);
  });

  it("starts a stopped manager and persists the completion report message", async () => {
    const harness = await createHarness();
    harnesses.push(harness);

    await harness.addAgent({
      agentId: "manager-1",
      managerId: "manager-1",
      role: "manager",
      status: "stopped",
    });
    await harness.addAgent({
      agentId: "worker-1",
      managerId: "manager-1",
      role: "worker",
      status: "busy",
    });

    publishAssistantCompletion(harness, "worker-1", {
      messageId: "msg-1",
      text: "Prepared the release summary.",
      includeStarted: true,
    });
    harness.sessionService.applyRuntimeStatus("worker-1", "idle");

    await waitForCondition(
      () => managerReportTexts(harness.manager, "manager-1").length === 1,
    );

    expect(harness.sessionService.getById("manager-1")?.status).toBe("idle");
    expect(harness.supervisor.spawnCalls).toContain("manager-1");
    expect(harness.core.operationService.listBySession("manager-1")).toEqual([
      expect.objectContaining({
        sessionId: "manager-1",
        type: "send_input",
        status: "pending",
      }),
    ]);
    expect(harness.core.messageStore.list("manager-1")).toEqual([
      expect.objectContaining({
        sessionId: "manager-1",
        role: "system",
        content: {
          text: [
            "SYSTEM: Worker worker-1 completed its turn.",
            "",
            "Last assistant message:",
            "Prepared the release summary.",
          ].join("\n"),
          parts: [
            {
              type: "text",
              text: [
                "SYSTEM: Worker worker-1 completed its turn.",
                "",
                "Last assistant message:",
                "Prepared the release summary.",
              ].join("\n"),
            },
          ],
        },
        metadata: {
          middleman: expect.objectContaining({
            renderAs: "hidden",
            visibility: "internal",
            routing: {
              fromAgentId: "worker-1",
              toAgentId: "manager-1",
              origin: "agent",
              requestedDelivery: "auto",
            },
          }),
        },
      }),
    ]);
  });
});
