import { CREATE_MANAGER_MODEL_PRESETS } from "@middleman/protocol";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createConfig } from "../config.js";
import { getAgentMemoryPath } from "../swarm/memory-paths.js";
import { SwarmManager } from "../swarm/swarm-manager.js";
import {
  MIDDLEMAN_STORE_MIGRATIONS,
  MiddlemanAgentRepo,
  MiddlemanManagerOrderRepo,
  MiddlemanSettingsRepo,
} from "../swarm/swarm-sql.js";
import {
  createDatabase,
  runMigrations,
  SessionRepo,
  type EventEnvelope,
  type SessionRecord,
  type SessionRuntimeConfig,
  type SwarmdCoreHandle,
} from "swarmd";

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

interface Harness {
  agentRepo: MiddlemanAgentRepo;
  close(): Promise<void>;
  compactCalls: Array<{ sessionId: string }>;
  createdMessages: Array<{ sessionId: string; text: string }>;
  interruptCalls: string[];
  manager: SwarmManager;
  managerOrderRepo: MiddlemanManagerOrderRepo;
  resetCalls: Array<{ sessionId: string; systemPrompt: string }>;
  sessionService: SwarmdCoreHandle["sessionService"];
  sessions: Map<string, SessionRecord>;
  startCalls: string[];
}

async function createHarness(): Promise<Harness> {
  const dataDir = await mkdtemp(resolve(tmpdir(), "middleman-swarm-lifecycle-"));
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
  const settingsRepo = new MiddlemanSettingsRepo(db);
  const sessionRepo = new SessionRepo(db);
  const sessions = new Map<string, SessionRecord>();
  const runtimeConfigBySessionId = new Map<
    string,
    Pick<SessionRuntimeConfig, "deliveryDefaults" | "backendConfig">
  >();
  const operationRecords = new Map<
    string,
    {
      id: string;
      sessionId: string;
      type: string;
      status: "pending" | "completed" | "failed";
      resultJson: string | null;
      errorJson: string | null;
      createdAt: string;
      completedAt: string | null;
    }
  >();
  const coreEventHandlers = new Set<(event: EventEnvelope) => void>();
  const compactCalls: Array<{ sessionId: string }> = [];
  const createdMessages: Array<{ sessionId: string; text: string }> = [];
  const interruptCalls: string[] = [];
  const resetCalls: Array<{ sessionId: string; systemPrompt: string }> = [];
  const startCalls: string[] = [];

  const sessionService = {
    create(input: {
      id?: string;
      backend: SessionRecord["backend"];
      cwd: string;
      model?: string;
      displayName?: string;
      systemPrompt?: string;
      backendConfig?: Record<string, unknown>;
      autoStart?: boolean;
    }) {
      const timestamp = new Date().toISOString();
      const session: SessionRecord = {
        id: input.id ?? `session-${sessions.size + 1}`,
        backend: input.backend,
        status: "created",
        displayName: input.displayName ?? input.id ?? "session",
        cwd: input.cwd,
        model: input.model ?? "",
        systemPrompt: input.systemPrompt,
        backendCheckpoint: null,
        createdAt: timestamp,
        updatedAt: timestamp,
        lastError: null,
        contextUsage: null,
      };
      const runtimeConfig = {
        backendConfig: { ...(input.backendConfig ?? {}) },
      };
      sessionRepo.create(session, runtimeConfig);
      sessions.set(session.id, session);
      runtimeConfigBySessionId.set(session.id, runtimeConfig);
      return session;
    },
    async start(sessionId: string) {
      const session = sessions.get(sessionId);
      if (!session) {
        throw new Error(`Missing session ${sessionId}`);
      }
      startCalls.push(sessionId);
      session.status = "idle";
      session.updatedAt = new Date().toISOString();
      sessionRepo.updateStatus(sessionId, "idle", null, session.contextUsage);
    },
    async stop(sessionId: string) {
      const session = sessions.get(sessionId);
      if (!session) {
        return;
      }
      session.status = "stopped";
      session.updatedAt = new Date().toISOString();
      sessionRepo.updateStatus(sessionId, "stopped", null, session.contextUsage);
    },
    async terminate(sessionId: string) {
      const session = sessions.get(sessionId);
      if (!session) {
        return;
      }
      session.status = "terminated";
      session.updatedAt = new Date().toISOString();
      sessionRepo.updateStatus(sessionId, "terminated", null, session.contextUsage);
    },
    reset(
      sessionId: string,
      input: {
        systemPrompt: string;
        runtimeConfig?: Pick<SessionRuntimeConfig, "deliveryDefaults" | "backendConfig">;
        updatedAt?: string;
      },
    ) {
      const session = sessions.get(sessionId);
      if (!session) {
        throw new Error(`Missing session ${sessionId}`);
      }
      session.status = "stopped";
      session.systemPrompt = input.systemPrompt;
      session.backendCheckpoint = null;
      session.lastError = null;
      session.updatedAt = input.updatedAt ?? new Date().toISOString();
      sessionRepo.resetState(sessionId, {
        systemPrompt: input.systemPrompt,
        runtimeConfig: input.runtimeConfig ?? { backendConfig: {} },
        updatedAt: session.updatedAt,
      });
      runtimeConfigBySessionId.set(sessionId, input.runtimeConfig ?? { backendConfig: {} });
      resetCalls.push({ sessionId, systemPrompt: input.systemPrompt });
      return session;
    },
    delete(sessionId: string) {
      sessionRepo.delete(sessionId);
      sessions.delete(sessionId);
      runtimeConfigBySessionId.delete(sessionId);
    },
    getById(sessionId: string) {
      return sessionRepo.getById(sessionId);
    },
    getRuntimeConfig(sessionId: string) {
      return runtimeConfigBySessionId.get(sessionId) ?? { backendConfig: {} };
    },
    getBackendState() {
      return null;
    },
    list(filter?: { status?: SessionRecord["status"][]; includeArchived?: boolean }) {
      return sessionRepo.list(filter);
    },
    archiveSession(sessionId: string) {
      sessionRepo.archiveSession(sessionId);
    },
    applyRuntimeStatus(
      sessionId: string,
      status: SessionRecord["status"],
      error: SessionRecord["lastError"],
      contextUsage: SessionRecord["contextUsage"],
    ) {
      const session = sessions.get(sessionId);
      if (!session) {
        throw new Error(`Missing session ${sessionId}`);
      }
      session.status = status;
      session.lastError = error;
      session.contextUsage = contextUsage;
      session.updatedAt = new Date().toISOString();
      sessionRepo.updateStatus(sessionId, status, error, contextUsage);
      return sessionRepo.getById(sessionId);
    },
  };

  const core = {
    config: { dataDir, dbPath: ":memory:" },
    db,
    supervisor: {
      hasWorker(sessionId: string) {
        const session = sessions.get(sessionId);
        return Boolean(session && session.status !== "stopped" && session.status !== "terminated");
      },
    } as SwarmdCoreHandle["supervisor"],
    sessionService: sessionService as unknown as SwarmdCoreHandle["sessionService"],
    messageService: {
      send(sessionId: string, parts: Array<{ type: string; text?: string }>) {
        const session = sessions.get(sessionId);
        if (!session || session.status !== "idle") {
          throw new Error(`Cannot send to ${sessionId} unless it is idle`);
        }
        createdMessages.push({
          sessionId,
          text: parts.find((part) => part.type === "text")?.text ?? "",
        });
        return {
          operationId: `op-${createdMessages.length}`,
          sessionId,
          acceptedDelivery: "auto",
          queued: false,
        };
      },
      interrupt(sessionId: string) {
        interruptCalls.push(sessionId);
        const session = sessions.get(sessionId);
        if (session) {
          session.status = "idle";
          session.updatedAt = new Date().toISOString();
          sessionRepo.updateStatus(sessionId, "idle", null, session.contextUsage);
        }
        return `interrupt-${interruptCalls.length}`;
      },
      compact(sessionId: string) {
        compactCalls.push({ sessionId });
        const operationId = `compact-${compactCalls.length}`;
        const now = new Date().toISOString();
        operationRecords.set(operationId, {
          id: operationId,
          sessionId,
          type: "compact",
          status: "completed",
          resultJson: JSON.stringify({ compacted: true }),
          errorJson: null,
          createdAt: now,
          completedAt: now,
        });
        return operationId;
      },
    } as SwarmdCoreHandle["messageService"],
    messageStore: {
      list() {
        return [];
      },
    } as unknown as SwarmdCoreHandle["messageStore"],
    operationService: {
      getById(operationId: string) {
        return operationRecords.get(operationId) ?? null;
      },
    } as SwarmdCoreHandle["operationService"],
    eventBus: {
      subscribe(handler: (event: EventEnvelope) => void) {
        coreEventHandlers.add(handler);
        return () => {
          coreEventHandlers.delete(handler);
        };
      },
      publish(event: EventEnvelope) {
        for (const handler of [...coreEventHandlers]) {
          handler(event);
        }
        return event;
      },
    } as unknown as SwarmdCoreHandle["eventBus"],
    recoveryManager: {
      async recover() {
        return { attempted: 0, recovered: 0, failed: 0, results: [] };
      },
    } as unknown as SwarmdCoreHandle["recoveryManager"],
    archiveSession(sessionId: string) {
      sessionRepo.archiveSession(sessionId);
    },
    async shutdown() {
      db.close();
    },
  } as unknown as SwarmdCoreHandle;

  Object.assign(manager as object, {
    core,
    agentRepo,
    managerOrderRepo,
    settingsRepo,
  });

  return {
    agentRepo,
    async close() {
      await rm(dataDir, { recursive: true, force: true });
      db.close();
    },
    compactCalls,
    createdMessages,
    interruptCalls,
    manager,
    managerOrderRepo,
    resetCalls,
    sessionService: sessionService as unknown as SwarmdCoreHandle["sessionService"],
    sessions,
    startCalls,
  };
}

describe("SwarmManager lifecycle", () => {
  const harnesses: Harness[] = [];

  afterEach(async () => {
    while (harnesses.length > 0) {
      await harnesses.pop()!.close();
    }
  });

  it("creates managers with a persisted row, session, and bootstrap message", async () => {
    const harness = await createHarness();
    harnesses.push(harness);

    const created = await harness.manager.createManager("__bootstrap_manager__", {
      name: "Product Manager",
      cwd: REPO_ROOT,
    });

    expect(created.agentId).toBe("product-manager");
    expect(created.model).toEqual({
      provider: "openai-codex",
      modelId: "gpt-5.4",
      thinkingLevel: "xhigh",
    });
    expect(harness.sessions.get(created.agentId)).toMatchObject({
      id: "product-manager",
      status: "idle",
      displayName: "product-manager",
    });
    expect(harness.agentRepo.get(created.agentId)).toMatchObject({
      sessionId: "product-manager",
      role: "manager",
      managerSessionId: "product-manager",
    });
    expect(harness.managerOrderRepo.list()).toEqual(["product-manager"]);
    expect(harness.createdMessages).toHaveLength(1);
    expect(harness.createdMessages[0]).toMatchObject({
      sessionId: "product-manager",
    });
    expect(harness.createdMessages[0].text).toContain("The Delegator");
  });

  it("rejects non-Pi manager creation presets", async () => {
    const harness = await createHarness();
    harnesses.push(harness);

    await expect(
      harness.manager.createManager("__bootstrap_manager__", {
        name: "Product Manager",
        cwd: REPO_ROOT,
        model: "codex-app",
      }),
    ).rejects.toThrow(
      `create_manager.model must be one of ${CREATE_MANAGER_MODEL_PRESETS.join("|")}`,
    );
  });

  it("resets and deletes manager state through swarmd session APIs", async () => {
    const harness = await createHarness();
    harnesses.push(harness);

    const managerDescriptor = await harness.manager.createManager("__bootstrap_manager__", {
      name: "Manager",
      cwd: REPO_ROOT,
      model: "pi-codex",
    });
    const workerDescriptor = await harness.manager.spawnAgent(managerDescriptor.agentId, {
      agentId: "worker",
      model: "codex-app",
    });

    await harness.manager.resetManagerSession(managerDescriptor.agentId);

    expect(harness.resetCalls).toHaveLength(1);
    expect(harness.resetCalls[0]).toMatchObject({
      sessionId: managerDescriptor.agentId,
    });
    expect(harness.resetCalls[0].systemPrompt).toContain("You are a worker agent in a swarm.");
    expect(harness.sessions.get(managerDescriptor.agentId)?.status).toBe("idle");
    expect(
      await readFileSafe(
        getAgentMemoryPath(harness.manager.getConfig().paths.dataDir, managerDescriptor.agentId),
      ),
    ).toBe("");

    const deleted = await harness.manager.deleteManager(
      managerDescriptor.agentId,
      managerDescriptor.agentId,
    );

    expect(deleted).toEqual({
      managerId: managerDescriptor.agentId,
      terminatedWorkerIds: [workerDescriptor.agentId],
    });
    expect(harness.sessions.size).toBe(0);
    expect(harness.agentRepo.get(managerDescriptor.agentId)).toBeNull();
    expect(harness.agentRepo.get(workerDescriptor.agentId)).toBeNull();
  });

  it("lazily restarts a stopped worker when sending it a new message", async () => {
    const harness = await createHarness();
    harnesses.push(harness);

    const managerDescriptor = await harness.manager.createManager("__bootstrap_manager__", {
      name: "Manager",
      cwd: REPO_ROOT,
      model: "pi-codex",
    });
    const workerDescriptor = await harness.manager.spawnAgent(managerDescriptor.agentId, {
      agentId: "worker",
      model: "codex-app",
    });

    harness.startCalls.length = 0;
    await harness.sessionService.stop(workerDescriptor.agentId);

    await harness.manager.sendMessage(
      managerDescriptor.agentId,
      workerDescriptor.agentId,
      "resume work",
    );

    expect(harness.startCalls).toEqual([workerDescriptor.agentId]);
    expect(harness.sessions.get(workerDescriptor.agentId)?.status).toBe("idle");
    expect(harness.createdMessages.at(-1)).toMatchObject({
      sessionId: workerDescriptor.agentId,
      text: "resume work",
    });
  });

  it("persists worker thinking level overrides in runtime config and descriptors", async () => {
    const harness = await createHarness();
    harnesses.push(harness);

    const managerDescriptor = await harness.manager.createManager("__bootstrap_manager__", {
      name: "Manager",
      cwd: REPO_ROOT,
      model: "pi-codex",
    });
    const workerDescriptor = await harness.manager.spawnAgent(managerDescriptor.agentId, {
      agentId: "worker",
      model: "codex-app",
      thinkingLevel: "low",
    });

    expect(workerDescriptor.model).toEqual({
      provider: "openai-codex-app-server",
      modelId: "gpt-5.4",
      thinkingLevel: "low",
    });
    expect(harness.sessionService.getRuntimeConfig(workerDescriptor.agentId)).toMatchObject({
      backendConfig: {
        thinkingLevel: "low",
      },
    });
    expect(harness.manager.getAgent(workerDescriptor.agentId)?.model.thinkingLevel).toBe("low");
  });

  it("emits manager-to-manager agent messages for both the sender and recipient manager views", async () => {
    const harness = await createHarness();
    harnesses.push(harness);

    const senderManager = await harness.manager.createManager("__bootstrap_manager__", {
      name: "Sender",
      cwd: REPO_ROOT,
      model: "pi-codex",
    });
    const recipientManager = await harness.manager.createManager(senderManager.agentId, {
      name: "Recipient",
      cwd: REPO_ROOT,
      model: "pi-codex",
    });

    const agentMessages: Array<{
      agentId: string;
      fromAgentId?: string;
      toAgentId: string;
      text: string;
    }> = [];
    harness.manager.on("agent_message", (event) => {
      agentMessages.push({
        agentId: event.agentId,
        fromAgentId: event.fromAgentId,
        toAgentId: event.toAgentId,
        text: event.text,
      });
    });

    await harness.manager.sendMessage(
      senderManager.agentId,
      recipientManager.agentId,
      "Can you handle the release?",
    );

    expect(harness.createdMessages.at(-1)).toMatchObject({
      sessionId: recipientManager.agentId,
      text: "Can you handle the release?",
    });
    expect(agentMessages).toEqual([
      {
        agentId: recipientManager.agentId,
        fromAgentId: senderManager.agentId,
        toAgentId: recipientManager.agentId,
        text: "Can you handle the release?",
      },
      {
        agentId: senderManager.agentId,
        fromAgentId: senderManager.agentId,
        toAgentId: recipientManager.agentId,
        text: "Can you handle the release?",
      },
    ]);
  });

  it("emits manager-to-worker agent messages for both manager and worker detail views", async () => {
    const harness = await createHarness();
    harnesses.push(harness);

    const managerDescriptor = await harness.manager.createManager("__bootstrap_manager__", {
      name: "Manager",
      cwd: REPO_ROOT,
      model: "pi-codex",
    });
    const workerDescriptor = await harness.manager.spawnAgent(managerDescriptor.agentId, {
      agentId: "worker",
      model: "codex-app",
    });

    const agentMessages: Array<{
      agentId: string;
      fromAgentId?: string;
      toAgentId: string;
      text: string;
    }> = [];
    harness.manager.on("agent_message", (event) => {
      agentMessages.push({
        agentId: event.agentId,
        fromAgentId: event.fromAgentId,
        toAgentId: event.toAgentId,
        text: event.text,
      });
    });

    await harness.manager.sendMessage(
      managerDescriptor.agentId,
      workerDescriptor.agentId,
      "Investigate the release failure",
    );

    expect(harness.createdMessages.at(-1)).toMatchObject({
      sessionId: workerDescriptor.agentId,
      text: "Investigate the release failure",
    });
    expect(agentMessages).toEqual([
      {
        agentId: managerDescriptor.agentId,
        fromAgentId: managerDescriptor.agentId,
        toAgentId: workerDescriptor.agentId,
        text: "Investigate the release failure",
      },
      {
        agentId: workerDescriptor.agentId,
        fromAgentId: managerDescriptor.agentId,
        toAgentId: workerDescriptor.agentId,
        text: "Investigate the release failure",
      },
    ]);
  });

  it("interrupts in-flight sessions for stop_all_agents without stopping them", async () => {
    const harness = await createHarness();
    harnesses.push(harness);

    const managerDescriptor = await harness.manager.createManager("__bootstrap_manager__", {
      name: "Manager",
      cwd: REPO_ROOT,
      model: "pi-codex",
    });
    const workerDescriptor = await harness.manager.spawnAgent(managerDescriptor.agentId, {
      agentId: "worker",
      model: "codex-app",
    });
    (harness.sessionService as any).applyRuntimeStatus(
      managerDescriptor.agentId,
      "busy",
      null,
      null,
    );
    (harness.sessionService as any).applyRuntimeStatus(
      workerDescriptor.agentId,
      "busy",
      null,
      null,
    );

    const stopped = await harness.manager.stopAllAgents(
      managerDescriptor.agentId,
      managerDescriptor.agentId,
    );

    expect(stopped).toEqual({
      managerId: managerDescriptor.agentId,
      stoppedWorkerIds: [workerDescriptor.agentId],
      managerStopped: true,
    });
    expect(harness.interruptCalls).toEqual([workerDescriptor.agentId, managerDescriptor.agentId]);
    expect(harness.manager.listAgents().map((agent) => agent.agentId)).toEqual([
      managerDescriptor.agentId,
      workerDescriptor.agentId,
    ]);
    expect(harness.sessions.get(managerDescriptor.agentId)?.status).toBe("idle");
    expect(harness.sessions.get(workerDescriptor.agentId)?.status).toBe("idle");
  });

  it("interrupts a single worker without deleting it", async () => {
    const harness = await createHarness();
    harnesses.push(harness);

    const managerDescriptor = await harness.manager.createManager("__bootstrap_manager__", {
      name: "Manager",
      cwd: REPO_ROOT,
      model: "pi-codex",
    });
    const workerDescriptor = await harness.manager.spawnAgent(managerDescriptor.agentId, {
      agentId: "worker",
      model: "codex-app",
    });
    (harness.sessionService as any).applyRuntimeStatus(
      workerDescriptor.agentId,
      "busy",
      null,
      null,
    );

    const interrupted = await harness.manager.interruptAgentForUser(
      managerDescriptor.agentId,
      workerDescriptor.agentId,
    );

    expect(interrupted).toEqual({
      agentId: workerDescriptor.agentId,
      interrupted: true,
    });
    expect(harness.interruptCalls).toEqual([workerDescriptor.agentId]);
    expect(harness.sessions.get(workerDescriptor.agentId)?.status).toBe("idle");
    expect(harness.manager.listAgents().map((agent) => agent.agentId)).toEqual([
      managerDescriptor.agentId,
      workerDescriptor.agentId,
    ]);
  });

  it("rejects interrupting a worker owned by another manager", async () => {
    const harness = await createHarness();
    harnesses.push(harness);

    const firstManager = await harness.manager.createManager("__bootstrap_manager__", {
      name: "Manager One",
      cwd: REPO_ROOT,
      model: "pi-codex",
    });
    const secondManager = await harness.manager.createManager(firstManager.agentId, {
      name: "Manager Two",
      cwd: REPO_ROOT,
      model: "pi-codex",
    });
    const workerDescriptor = await harness.manager.spawnAgent(firstManager.agentId, {
      agentId: "worker",
      model: "codex-app",
    });

    await expect(
      harness.manager.interruptAgentForUser(secondManager.agentId, workerDescriptor.agentId),
    ).rejects.toThrow(`Only the owning manager can interrupt ${workerDescriptor.agentId}.`);
  });

  it("treats interrupting an idle worker as a no-op", async () => {
    const harness = await createHarness();
    harnesses.push(harness);

    const managerDescriptor = await harness.manager.createManager("__bootstrap_manager__", {
      name: "Manager",
      cwd: REPO_ROOT,
      model: "pi-codex",
    });
    const workerDescriptor = await harness.manager.spawnAgent(managerDescriptor.agentId, {
      agentId: "worker",
      model: "codex-app",
    });

    const interrupted = await harness.manager.interruptAgentForUser(
      managerDescriptor.agentId,
      workerDescriptor.agentId,
    );

    expect(interrupted).toEqual({
      agentId: workerDescriptor.agentId,
      interrupted: false,
    });
    expect(harness.interruptCalls).toEqual([]);
    expect(harness.sessions.get(workerDescriptor.agentId)?.status).toBe("idle");
  });

  it("compacts an idle Pi manager session", async () => {
    const harness = await createHarness();
    harnesses.push(harness);

    const managerDescriptor = await harness.manager.createManager("__bootstrap_manager__", {
      name: "Manager",
      cwd: REPO_ROOT,
      model: "pi-codex",
    });

    const compacted = await harness.manager.compactAgentForUser(
      managerDescriptor.agentId,
      managerDescriptor.agentId,
    );

    expect(compacted).toEqual({
      agentId: managerDescriptor.agentId,
      compacted: true,
    });
    expect(harness.compactCalls).toEqual([{ sessionId: managerDescriptor.agentId }]);
  });

  it("waits for Pi worker compaction to complete before resolving", async () => {
    const harness = await createHarness();
    harnesses.push(harness);

    const managerDescriptor = await harness.manager.createManager("__bootstrap_manager__", {
      name: "Manager",
      cwd: REPO_ROOT,
      model: "pi-codex",
    });
    const workerDescriptor = await harness.manager.spawnAgent(managerDescriptor.agentId, {
      agentId: "worker",
      model: "pi-codex",
    });

    const core = (harness.manager as any).core as SwarmdCoreHandle;
    const operationId = "compact-async-1";
    let status: "pending" | "completed" = "pending";

    core.messageService.compact = vi.fn((sessionId: string) => {
      harness.compactCalls.push({ sessionId });
      return operationId;
    }) as SwarmdCoreHandle["messageService"]["compact"];
    core.operationService.getById = vi.fn((requestedOperationId: string) => {
      if (requestedOperationId !== operationId) {
        return null;
      }

      return {
        id: operationId,
        sessionId: workerDescriptor.agentId,
        type: "compact",
        status,
        resultJson: status === "completed" ? JSON.stringify({ compacted: true }) : null,
        errorJson: null,
        createdAt: "2026-03-23T00:00:00.000Z",
        completedAt: status === "completed" ? "2026-03-23T00:00:01.000Z" : null,
      };
    }) as SwarmdCoreHandle["operationService"]["getById"];

    let settled = false;
    const compactPromise = harness.manager
      .compactAgentForUser(managerDescriptor.agentId, workerDescriptor.agentId)
      .then((result) => {
        settled = true;
        return result;
      });

    await Promise.resolve();
    expect(settled).toBe(false);

    status = "completed";
    core.eventBus.publish({
      id: "evt-compact-1",
      cursor: null,
      sessionId: workerDescriptor.agentId,
      threadId: null,
      timestamp: "2026-03-23T00:00:01.000Z",
      source: "server",
      type: "operation.completed",
      payload: {
        operationId,
        status: "completed",
        result: { compacted: true },
      },
    });

    await expect(compactPromise).resolves.toEqual({
      agentId: workerDescriptor.agentId,
      compacted: true,
    });
    expect(harness.compactCalls).toEqual([{ sessionId: workerDescriptor.agentId }]);
  });

  it("rejects compacting a worker owned by another manager", async () => {
    const harness = await createHarness();
    harnesses.push(harness);

    const firstManager = await harness.manager.createManager("__bootstrap_manager__", {
      name: "Manager One",
      cwd: REPO_ROOT,
      model: "pi-codex",
    });
    const secondManager = await harness.manager.createManager(firstManager.agentId, {
      name: "Manager Two",
      cwd: REPO_ROOT,
      model: "pi-codex",
    });
    const workerDescriptor = await harness.manager.spawnAgent(firstManager.agentId, {
      agentId: "worker",
      model: "pi-codex",
    });

    await expect(
      harness.manager.compactAgentForUser(secondManager.agentId, workerDescriptor.agentId),
    ).rejects.toThrow(`Only the owning manager can compact ${workerDescriptor.agentId}.`);
  });

  it("rejects compacting non-Pi sessions and busy Pi sessions", async () => {
    const harness = await createHarness();
    harnesses.push(harness);

    const managerDescriptor = await harness.manager.createManager("__bootstrap_manager__", {
      name: "Manager",
      cwd: REPO_ROOT,
      model: "pi-codex",
    });
    const nonPiWorker = await harness.manager.spawnAgent(managerDescriptor.agentId, {
      agentId: "worker-codex",
      model: "codex-app",
    });
    const piWorker = await harness.manager.spawnAgent(managerDescriptor.agentId, {
      agentId: "worker-pi",
      model: "pi-codex",
    });

    await expect(
      harness.manager.compactAgentForUser(managerDescriptor.agentId, nonPiWorker.agentId),
    ).rejects.toThrow(`Agent ${nonPiWorker.agentId} is not using the Pi backend.`);

    (harness.sessionService as any).applyRuntimeStatus(piWorker.agentId, "busy", null, null);

    await expect(
      harness.manager.compactAgentForUser(managerDescriptor.agentId, piWorker.agentId),
    ).rejects.toThrow(
      `Agent ${piWorker.agentId} is busy. Wait for the current turn to finish or interrupt it before compacting.`,
    );
  });

  it("archives killed workers and omits them from default listings while keeping manager deletion cleanup intact", async () => {
    const harness = await createHarness();
    harnesses.push(harness);

    const managerDescriptor = await harness.manager.createManager("__bootstrap_manager__", {
      name: "Manager",
      cwd: REPO_ROOT,
      model: "pi-codex",
    });
    const workerDescriptor = await harness.manager.spawnAgent(managerDescriptor.agentId, {
      agentId: "worker",
      model: "codex-app",
    });

    await harness.manager.killAgent(managerDescriptor.agentId, workerDescriptor.agentId);

    expect(harness.manager.listAgents().map((agent) => agent.agentId)).toEqual([
      managerDescriptor.agentId,
    ]);
    expect(
      harness.manager.listAgents({ includeArchived: true }).map((agent) => agent.agentId),
    ).toEqual([managerDescriptor.agentId, workerDescriptor.agentId]);
    expect(harness.sessionService.getById(workerDescriptor.agentId)?.status).toBe("terminated");

    const deleted = await harness.manager.deleteManager(
      managerDescriptor.agentId,
      managerDescriptor.agentId,
    );

    expect(deleted).toEqual({
      managerId: managerDescriptor.agentId,
      terminatedWorkerIds: [workerDescriptor.agentId],
    });
    expect(harness.sessions.size).toBe(0);
  });

  it("defaults speak_to_user delivery to web and preserves explicit web targets", async () => {
    const harness = await createHarness();
    harnesses.push(harness);

    const managerDescriptor = await harness.manager.createManager("__bootstrap_manager__", {
      name: "Manager",
      cwd: REPO_ROOT,
      model: "pi-codex",
    });

    await harness.manager.handleUserMessage("hello from the web", {
      targetAgentId: managerDescriptor.agentId,
      sourceContext: {
        channel: "web",
      },
    });

    expect(harness.agentRepo.get(managerDescriptor.agentId)?.replyTarget).toBeUndefined();

    const explicitReply = await harness.manager.publishToUser(
      managerDescriptor.agentId,
      "Reply on the web",
      "speak_to_user",
      {
        channel: "web",
      },
    );

    expect(explicitReply.targetContext).toEqual({
      channel: "web",
    });
    expect(harness.agentRepo.get(managerDescriptor.agentId)?.replyTarget).toEqual({
      channel: "web",
    });

    const defaultReply = await harness.manager.publishToUser(
      managerDescriptor.agentId,
      "Reply on the web",
    );

    expect(defaultReply.targetContext).toEqual({
      channel: "web",
    });
    expect(harness.agentRepo.get(managerDescriptor.agentId)?.replyTarget).toEqual({
      channel: "web",
    });
  });
});

async function readFileSafe(path: string): Promise<string> {
  try {
    return await import("node:fs/promises").then(({ readFile }) => readFile(path, "utf8"));
  } catch {
    return "";
  }
}
