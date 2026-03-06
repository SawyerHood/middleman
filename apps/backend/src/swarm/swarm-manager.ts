import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ServerEvent } from "@middleman/protocol";
import { TaskStorage } from "../tasks/task-storage.js";
import {
  loadArchetypePromptRegistry,
  normalizeArchetypeId,
  type ArchetypePromptRegistry
} from "./archetypes/archetype-prompt-registry.js";
import { ConversationProjector } from "./conversation-projector.js";
import { getAgentMemoryPath as getAgentMemoryPathForDataDir } from "./memory-paths.js";
import { PersistenceService } from "./persistence-service.js";
import { RuntimeFactory } from "./runtime-factory.js";
import { SecretsEnvService } from "./secrets-env-service.js";
import { SkillMetadataService } from "./skill-metadata-service.js";
import {
  listDirectories,
  normalizeAllowlistRoots,
  validateDirectory as validateDirectoryInput,
  validateDirectoryPath,
  type DirectoryListingResult,
  type DirectoryValidationResult
} from "./cwd-policy.js";
import { pickDirectory as pickNativeDirectory } from "./directory-picker.js";
import {
  isConversationBinaryAttachment,
  isConversationImageAttachment,
  isConversationTextAttachment
} from "./conversation-validators.js";
import {
  extractMessageText,
  extractRole,
} from "./message-utils.js";
import {
  DEFAULT_SWARM_MODEL_PRESET,
  inferSwarmModelPresetFromDescriptor,
  normalizeSwarmModelDescriptor,
  parseSwarmModelPreset,
  resolveModelDescriptorFromPreset
} from "./model-presets.js";
import {
  isNonRunningAgentStatus,
  normalizeAgentStatus,
  transitionAgentStatus,
  type AgentStatusInput
} from "./agent-state-machine.js";
import type {
  RuntimeImageAttachment,
  RuntimeErrorEvent,
  RuntimeSessionEvent,
  RuntimeUserMessage,
  SwarmAgentRuntime
} from "./runtime-types.js";
import type { SwarmToolHost } from "./swarm-tools.js";
import type {
  AgentMessageEvent,
  AgentContextUsage,
  AgentDescriptor,
  AgentModelDescriptor,
  AgentStatus,
  AgentStatusEvent,
  AgentsSnapshotEvent,
  AgentsStoreFile,
  ConversationAttachment,
  ConversationAttachmentMetadata,
  ConversationBinaryAttachment,
  ConversationEntryEvent,
  ConversationMessageEvent,
  ConversationTextAttachment,
  MessageSourceContext,
  MessageTargetContext,
  RequestedDeliveryMode,
  SendMessageReceipt,
  SettingsAuthProvider,
  SkillEnvRequirement,
  SpawnAgentInput,
  SwarmConfig,
  SwarmModelPreset,
  UserTask
} from "./types.js";

const DEFAULT_WORKER_SYSTEM_PROMPT = `You are a worker agent in a swarm.
- You can list agents and send messages to other agents.
- Use coding tools (read/bash/edit/write) to execute implementation tasks.
- Report progress and outcomes back to the manager using send_message_to_agent.
- You are not user-facing.
- End users only see messages they send and manager speak_to_user outputs.
- Your plain assistant text is not directly visible to end users.
- Incoming messages prefixed with "SYSTEM:" are internal control/context updates, not direct end-user chat.
- Persistent memory for this runtime is at \${SWARM_MEMORY_FILE} and is auto-loaded into context.
- Workers read their owning manager's memory file.
- Only write memory when explicitly asked to remember/update/forget durable information.
- Follow the memory skill workflow before editing the memory file, and never store secrets in memory.`;
const MANAGER_ARCHETYPE_ID = "manager";
const MERGER_ARCHETYPE_ID = "merger";
const INTERNAL_MODEL_MESSAGE_PREFIX = "SYSTEM: ";
const MANAGER_BOOTSTRAP_INTERVIEW_MESSAGE = `You are a newly created manager agent for this user.

Send a warm welcome via speak_to_user and explain that you orchestrate worker agents to get work done quickly and safely.

Then run a short onboarding interview. Ask:
1. What kinds of projects/tasks they expect to work on most.
2. Whether they prefer delegation-heavy execution or hands-on collaboration.
3. Which tools/integrations matter most (Slack, Telegram, cron scheduling, web search, etc.).
4. Any coding/process preferences (style conventions, testing expectations, branching/PR habits).
5. Communication style preferences (concise vs detailed, formal vs casual, update cadence).

Offer this example workflow to show what's possible:

"The Delegator" workflow:
- User describes a feature or task.
- Manager spawns a codex worker in a git worktree branch.
- Worker implements and validates (typecheck, build, tests).
- Merger agent merges the branch to main.
- Multiple independent tasks can run in parallel across separate workers.
- Use different model workers for different strengths (e.g. opus for UI polish, codex for backend).
- Manager focuses on orchestration and concise status updates.
- Memory file tracks preferences, decisions, and project context across sessions.

This is just one example — ask the user how they'd like to work and adapt to their style.

Close by asking if they want you to save their preferences to memory for future sessions.
If they agree, summarize the choices and persist them using the memory workflow.`;
// Retain recent non-web activity while preserving the full user-facing web transcript.
const SWARM_CONTEXT_FILE_NAME = "SWARM.md";
const SWARM_MANAGER_MAX_EVENT_LISTENERS = 64;

function nowIso(): string {
  return new Date().toISOString();
}

function createEmptyArchetypePromptRegistry(): ArchetypePromptRegistry {
  return {
    resolvePrompt: () => undefined,
    listArchetypeIds: () => []
  };
}

function cloneContextUsage(contextUsage: AgentContextUsage | undefined): AgentContextUsage | undefined {
  if (!contextUsage) {
    return undefined;
  }

  return {
    tokens: contextUsage.tokens,
    contextWindow: contextUsage.contextWindow,
    percent: contextUsage.percent
  };
}

function cloneDescriptor(descriptor: AgentDescriptor): AgentDescriptor {
  return {
    ...descriptor,
    model: { ...descriptor.model },
    contextUsage: cloneContextUsage(descriptor.contextUsage)
  };
}

function normalizeContextUsage(contextUsage: AgentContextUsage | undefined): AgentContextUsage | undefined {
  if (!contextUsage) {
    return undefined;
  }

  if (
    typeof contextUsage.tokens !== "number" ||
    !Number.isFinite(contextUsage.tokens) ||
    contextUsage.tokens < 0
  ) {
    return undefined;
  }

  if (
    typeof contextUsage.contextWindow !== "number" ||
    !Number.isFinite(contextUsage.contextWindow) ||
    contextUsage.contextWindow <= 0
  ) {
    return undefined;
  }

  if (typeof contextUsage.percent !== "number" || !Number.isFinite(contextUsage.percent)) {
    return undefined;
  }

  return {
    tokens: Math.round(contextUsage.tokens),
    contextWindow: Math.max(1, Math.round(contextUsage.contextWindow)),
    percent: Math.max(0, Math.min(100, contextUsage.percent))
  };
}

function areContextUsagesEqual(
  left: AgentContextUsage | undefined,
  right: AgentContextUsage | undefined
): boolean {
  if (!left && !right) {
    return true;
  }

  if (!left || !right) {
    return false;
  }

  return (
    left.tokens === right.tokens &&
    left.contextWindow === right.contextWindow &&
    left.percent === right.percent
  );
}

export class SwarmManager extends EventEmitter implements SwarmToolHost {
  private readonly config: SwarmConfig;
  private readonly now: () => string;
  private readonly defaultModelPreset: SwarmModelPreset;

  private readonly descriptors = new Map<string, AgentDescriptor>();
  private readonly runtimes = new Map<string, SwarmAgentRuntime>();
  private readonly conversationEntriesByAgentId = new Map<string, ConversationEntryEvent[]>();
  private readonly conversationProjector: ConversationProjector;
  private readonly persistenceService: PersistenceService;
  private readonly taskStorage: TaskStorage;
  private readonly runtimeFactory: RuntimeFactory;
  private readonly skillMetadataService: SkillMetadataService;
  private readonly secretsEnvService: SecretsEnvService;

  private archetypePromptRegistry: ArchetypePromptRegistry = createEmptyArchetypePromptRegistry();

  constructor(config: SwarmConfig, options?: { now?: () => string }) {
    super();

    this.defaultModelPreset =
      inferSwarmModelPresetFromDescriptor(config.defaultModel) ?? DEFAULT_SWARM_MODEL_PRESET;
    this.config = {
      ...config,
      defaultModel: resolveModelDescriptorFromPreset(this.defaultModelPreset)
    };
    this.now = options?.now ?? nowIso;
    this.persistenceService = new PersistenceService({
      config: this.config,
      descriptors: this.descriptors,
      sortedDescriptors: () => this.sortedDescriptors(),
      getConfiguredManagerId: () => this.getConfiguredManagerId(),
      resolveMemoryOwnerAgentId: (descriptor) => this.resolveMemoryOwnerAgentId(descriptor),
      validateAgentDescriptor,
      extractDescriptorAgentId,
      logDebug: (message, details) => this.logDebug(message, details)
    });
    this.taskStorage = new TaskStorage({
      dataDir: this.config.paths.dataDir,
      now: this.now
    });
    this.conversationProjector = new ConversationProjector({
      descriptors: this.descriptors,
      runtimes: this.runtimes,
      conversationEntriesByAgentId: this.conversationEntriesByAgentId,
      now: this.now,
      emitServerEvent: (eventName, payload) => {
        this.emit(eventName, payload);
      },
      logDebug: (message, details) => this.logDebug(message, details)
    });
    this.skillMetadataService = new SkillMetadataService({
      config: this.config
    });
    this.secretsEnvService = new SecretsEnvService({
      config: this.config,
      ensureSkillMetadataLoaded: () => this.skillMetadataService.ensureSkillMetadataLoaded(),
      getSkillMetadata: () => this.skillMetadataService.getSkillMetadata()
    });
    this.runtimeFactory = new RuntimeFactory({
      host: this,
      config: this.config,
      now: this.now,
      logDebug: (message, details) => this.logDebug(message, details),
      getMemoryRuntimeResources: async (descriptor) => this.getMemoryRuntimeResources(descriptor),
      getSwarmContextFiles: async (cwd) => this.getSwarmContextFiles(cwd),
      mergeRuntimeContextFiles: (baseAgentsFiles, options) =>
        this.mergeRuntimeContextFiles(baseAgentsFiles, options),
      callbacks: {
        onStatusChange: async (agentId, status, pendingCount, contextUsage) => {
          await this.handleRuntimeStatus(agentId, status, pendingCount, contextUsage);
        },
        onSessionEvent: async (agentId, event) => {
          await this.handleRuntimeSessionEvent(agentId, event);
        },
        onAgentEnd: async (agentId) => {
          await this.handleRuntimeAgentEnd(agentId);
        },
        onRuntimeError: async (agentId, error) => {
          await this.handleRuntimeError(agentId, error);
        }
      }
    });
    this.setMaxListeners(SWARM_MANAGER_MAX_EVENT_LISTENERS);
  }

  async boot(): Promise<void> {
    this.logDebug("boot:start", {
      host: this.config.host,
      port: this.config.port,
      authFile: this.config.paths.authFile,
      managerId: this.config.managerId
    });

    await this.ensureDirectories();
    await this.taskStorage.load();
    await this.loadSecretsStore();
    await this.reloadSkillMetadata();

    try {
      this.config.defaultCwd = await this.resolveAndValidateCwd(this.config.defaultCwd);
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(`Invalid default working directory: ${error.message}`);
      }
      throw error;
    }

    this.archetypePromptRegistry = await loadArchetypePromptRegistry({
      repoOverridesDir: this.config.paths.repoArchetypesDir
    });

    const loaded = await this.loadStore();
    for (const descriptor of loaded.agents) {
      this.descriptors.set(descriptor.agentId, descriptor);
    }
    this.normalizeStreamingStatusesForBoot();

    await this.ensureMemoryFilesForBoot();
    await this.saveStore();

    this.loadConversationHistoriesFromStore();
    await this.restoreRuntimesForBoot();

    const managerDescriptor = this.getBootLogManagerDescriptor();
    this.emitAgentsSnapshot();

    this.logDebug("boot:ready", {
      managerId: managerDescriptor?.agentId,
      managerStatus: managerDescriptor?.status,
      model: managerDescriptor?.model,
      cwd: managerDescriptor?.cwd,
      managerAgentDir: this.config.paths.managerAgentDir,
      managerSystemPromptSource: managerDescriptor ? `archetype:${MANAGER_ARCHETYPE_ID}` : undefined,
      loadedArchetypeIds: this.archetypePromptRegistry.listArchetypeIds(),
      restoredAgentIds: Array.from(this.runtimes.keys())
    });
  }

  listAgents(): AgentDescriptor[] {
    return this.sortedDescriptors().map((descriptor) => cloneDescriptor(descriptor));
  }

  getConversationHistory(agentId?: string, options?: { limit?: number }): ConversationEntryEvent[] {
    const resolvedAgentId = normalizeOptionalAgentId(agentId) ?? this.resolvePreferredManagerId();
    if (!resolvedAgentId) {
      return [];
    }

    return this.conversationProjector.getConversationHistory(resolvedAgentId, options?.limit);
  }

  getVisibleTranscript(agentId?: string, options?: { limit?: number }): ConversationMessageEvent[] {
    const resolvedAgentId = normalizeOptionalAgentId(agentId) ?? this.resolvePreferredManagerId();
    if (!resolvedAgentId) {
      return [];
    }

    return this.conversationProjector.getVisibleTranscript(resolvedAgentId, options?.limit);
  }

  async spawnAgent(callerAgentId: string, input: SpawnAgentInput): Promise<AgentDescriptor> {
    const manager = this.assertManager(callerAgentId, "spawn agents");

    const requestedAgentId = input.agentId?.trim();
    if (!requestedAgentId) {
      throw new Error("spawn_agent requires a non-empty agentId");
    }

    const agentId = this.generateUniqueAgentId(requestedAgentId);
    const createdAt = this.now();

    const model = this.resolveSpawnModel(input.model, manager.model);
    const archetypeId = this.resolveSpawnWorkerArchetypeId(input, agentId);

    const descriptor: AgentDescriptor = {
      agentId,
      displayName: agentId,
      role: "worker",
      managerId: manager.agentId,
      archetypeId,
      status: "idle",
      createdAt,
      updatedAt: createdAt,
      cwd: input.cwd ? await this.resolveAndValidateCwd(input.cwd) : manager.cwd,
      model,
      sessionFile: join(this.config.paths.sessionsDir, `${agentId}.jsonl`)
    };

    this.descriptors.set(agentId, descriptor);
    await this.saveStore();

    this.logDebug("agent:spawn", {
      callerAgentId,
      agentId,
      managerId: descriptor.managerId,
      displayName: descriptor.displayName,
      archetypeId: descriptor.archetypeId,
      model: descriptor.model,
      cwd: descriptor.cwd
    });

    const explicitSystemPrompt = input.systemPrompt?.trim();
    const runtimeSystemPrompt =
      explicitSystemPrompt && explicitSystemPrompt.length > 0
        ? explicitSystemPrompt
        : this.resolveSystemPromptForDescriptor(descriptor);

    const runtime = await this.createRuntimeForDescriptor(descriptor, runtimeSystemPrompt);
    this.runtimes.set(agentId, runtime);

    const contextUsage = runtime.getContextUsage();
    descriptor.contextUsage = contextUsage;

    this.emitStatus(agentId, descriptor.status, runtime.getPendingCount(), contextUsage);
    this.emitAgentsSnapshot();

    if (input.initialMessage && input.initialMessage.trim().length > 0) {
      await this.sendMessage(callerAgentId, agentId, input.initialMessage, "auto", { origin: "internal" });
    }

    return cloneDescriptor(descriptor);
  }

  async killAgent(callerAgentId: string, targetAgentId: string): Promise<void> {
    const manager = this.assertManager(callerAgentId, "kill agents");

    const target = this.descriptors.get(targetAgentId);
    if (!target) {
      throw new Error(`Unknown agent: ${targetAgentId}`);
    }
    if (target.role === "manager") {
      throw new Error("Manager cannot be killed");
    }

    if (target.managerId !== manager.agentId) {
      throw new Error(`Only owning manager can kill agent ${targetAgentId}`);
    }

    await this.terminateDescriptor(target, { abort: true, emitStatus: false });
    await this.saveStore();

    this.logDebug("agent:kill", {
      callerAgentId,
      targetAgentId,
      managerId: manager.agentId
    });

    this.emitStatus(targetAgentId, target.status, 0);
    this.emitAgentsSnapshot();
  }

  async stopAllAgents(
    callerAgentId: string,
    targetManagerId: string
  ): Promise<{
    managerId: string;
    stoppedWorkerIds: string[];
    managerStopped: boolean;
    terminatedWorkerIds: string[];
    managerTerminated: boolean;
  }> {
    const manager = this.assertManager(callerAgentId, "stop all agents");

    const target = this.descriptors.get(targetManagerId);
    if (!target || target.role !== "manager") {
      throw new Error(`Unknown manager: ${targetManagerId}`);
    }

    if (target.agentId !== manager.agentId) {
      throw new Error(`Only selected manager can stop all agents for ${targetManagerId}`);
    }

    const stoppedWorkerIds: string[] = [];

    for (const descriptor of Array.from(this.descriptors.values())) {
      if (descriptor.role !== "worker") {
        continue;
      }

      if (descriptor.managerId !== targetManagerId) {
        continue;
      }

      if (isNonRunningAgentStatus(descriptor.status)) {
        continue;
      }

      const runtime = this.runtimes.get(descriptor.agentId);
      if (runtime) {
        await runtime.stopInFlight({ abort: true });
      } else {
        descriptor.status = transitionAgentStatus(descriptor.status, "idle");
        descriptor.updatedAt = this.now();
        this.descriptors.set(descriptor.agentId, descriptor);
        this.emitStatus(descriptor.agentId, descriptor.status, 0, descriptor.contextUsage);
      }

      stoppedWorkerIds.push(descriptor.agentId);
    }

    let managerStopped = false;
    if (!isNonRunningAgentStatus(target.status)) {
      const managerRuntime = this.runtimes.get(target.agentId);
      if (managerRuntime) {
        await managerRuntime.stopInFlight({ abort: true });
      } else {
        target.status = transitionAgentStatus(target.status, "idle");
        target.updatedAt = this.now();
        this.descriptors.set(target.agentId, target);
        this.emitStatus(target.agentId, target.status, 0, target.contextUsage);
      }

      managerStopped = true;
    }

    await this.saveStore();
    this.emitAgentsSnapshot();

    this.logDebug("manager:stop_all", {
      callerAgentId,
      targetManagerId,
      stoppedWorkerIds,
      managerStopped
    });

    return {
      managerId: targetManagerId,
      stoppedWorkerIds,
      managerStopped,
      // Backward compatibility for older clients still expecting terminated-oriented fields.
      terminatedWorkerIds: stoppedWorkerIds,
      managerTerminated: managerStopped
    };
  }

  async createManager(
    callerAgentId: string,
    input: { name: string; cwd: string; model?: SwarmModelPreset }
  ): Promise<AgentDescriptor> {
    const callerDescriptor = this.descriptors.get(callerAgentId);
    if (!callerDescriptor || callerDescriptor.role !== "manager") {
      const canBootstrap = !this.hasRunningManagers();
      if (!canBootstrap) {
        throw new Error("Only manager can create managers");
      }
    } else if (isNonRunningAgentStatus(callerDescriptor.status)) {
      throw new Error(`Manager is not running: ${callerAgentId}`);
    }

    const requestedName = input.name?.trim();
    if (!requestedName) {
      throw new Error("create_manager requires a non-empty name");
    }

    const requestedModelPreset = parseSwarmModelPreset(input.model, "create_manager.model");
    const managerId = this.generateUniqueManagerId(requestedName);
    const createdAt = this.now();
    const cwd = await this.resolveAndValidateCwd(input.cwd);

    const descriptor: AgentDescriptor = {
      agentId: managerId,
      displayName: managerId,
      role: "manager",
      managerId,
      archetypeId: MANAGER_ARCHETYPE_ID,
      status: "idle",
      createdAt,
      updatedAt: createdAt,
      cwd,
      model: requestedModelPreset
        ? resolveModelDescriptorFromPreset(requestedModelPreset)
        : this.resolveDefaultModelDescriptor(),
      sessionFile: join(this.config.paths.sessionsDir, `${managerId}.jsonl`)
    };

    this.descriptors.set(descriptor.agentId, descriptor);

    let runtime: SwarmAgentRuntime;
    try {
      runtime = await this.createRuntimeForDescriptor(
        descriptor,
        this.resolveSystemPromptForDescriptor(descriptor)
      );
    } catch (error) {
      this.descriptors.delete(descriptor.agentId);
      throw error;
    }

    this.runtimes.set(managerId, runtime);
    await this.saveStore();

    const contextUsage = runtime.getContextUsage();
    descriptor.contextUsage = contextUsage;

    this.emitStatus(managerId, descriptor.status, runtime.getPendingCount(), contextUsage);
    this.emitAgentsSnapshot();

    this.logDebug("manager:create", {
      callerAgentId,
      managerId,
      cwd: descriptor.cwd
    });

    await this.sendManagerBootstrapMessage(managerId);

    return cloneDescriptor(descriptor);
  }

  async deleteManager(
    callerAgentId: string,
    targetManagerId: string
  ): Promise<{ managerId: string; terminatedWorkerIds: string[] }> {
    this.assertManager(callerAgentId, "delete managers");

    const target = this.descriptors.get(targetManagerId);
    if (!target || target.role !== "manager") {
      throw new Error(`Unknown manager: ${targetManagerId}`);
    }

    const terminatedWorkerIds: string[] = [];

    for (const descriptor of Array.from(this.descriptors.values())) {
      if (descriptor.role !== "worker") {
        continue;
      }
      if (descriptor.managerId !== targetManagerId) {
        continue;
      }

      terminatedWorkerIds.push(descriptor.agentId);
      await this.terminateDescriptor(descriptor, { abort: true, emitStatus: true });
      this.descriptors.delete(descriptor.agentId);
      this.conversationProjector.deleteConversationHistory(descriptor.agentId);
    }

    await this.terminateDescriptor(target, { abort: true, emitStatus: true });
    this.descriptors.delete(targetManagerId);
    this.conversationProjector.deleteConversationHistory(targetManagerId);

    await this.deleteManagerSchedulesFile(targetManagerId);
    const deletedTaskIds = await this.taskStorage.deleteForManager(targetManagerId);
    await this.saveStore();
    this.emitAgentsSnapshot();
    if (deletedTaskIds.length > 0) {
      this.emitTasksDeleted(deletedTaskIds);
    }

    this.logDebug("manager:delete", {
      callerAgentId,
      targetManagerId,
      terminatedWorkerIds,
      deletedTaskIds
    });

    return { managerId: targetManagerId, terminatedWorkerIds };
  }

  async createTaskForManager(
    managerId: string,
    input: { title: string; description?: string }
  ): Promise<UserTask> {
    const manager = this.assertManager(managerId, "manage tasks");
    const title = input.title.trim();
    if (title.length === 0) {
      throw new Error("task title must be a non-empty string");
    }

    const task = await this.taskStorage.create({
      managerId: manager.agentId,
      title,
      description: input.description
    });

    this.logDebug("task:assign", {
      managerId: manager.agentId,
      taskId: task.id,
      title: task.title
    });
    this.emitTaskCreated(task);

    return task;
  }

  async listOutstandingTasksForManager(managerId: string): Promise<UserTask[]> {
    const manager = this.assertManager(managerId, "manage tasks");
    return this.taskStorage.listOutstanding(manager.agentId);
  }

  listAllTasks(): UserTask[] {
    return this.taskStorage.listAll();
  }

  async addTaskComment(taskId: string, comment: string): Promise<UserTask> {
    const normalizedTaskId = taskId.trim();
    if (normalizedTaskId.length === 0) {
      throw new Error("add_task_comment taskId must be a non-empty string");
    }

    const updatedTask = await this.taskStorage.addComment(normalizedTaskId, comment);

    this.logDebug("task:comment", {
      taskId: updatedTask.id,
      managerId: updatedTask.managerId
    });
    this.emitTaskUpdated(updatedTask);

    return updatedTask;
  }

  async updateTask(
    taskId: string,
    input: {
      title?: string;
      description?: string;
    }
  ): Promise<UserTask> {
    const normalizedTaskId = taskId.trim();
    if (normalizedTaskId.length === 0) {
      throw new Error("update_task taskId must be a non-empty string");
    }
    if (input.title === undefined && input.description === undefined) {
      throw new Error("update_task requires title or description");
    }

    const updatedTask = await this.taskStorage.update(normalizedTaskId, input);

    this.logDebug("task:update", {
      taskId: updatedTask.id,
      managerId: updatedTask.managerId,
      updatedTitle: input.title !== undefined,
      updatedDescription: input.description !== undefined
    });
    this.emitTaskUpdated(updatedTask);

    return updatedTask;
  }

  async updateTaskForManager(
    managerId: string,
    taskId: string,
    input: {
      title?: string;
      description?: string;
    }
  ): Promise<UserTask> {
    const manager = this.assertManager(managerId, "manage tasks");
    const existingTask = this.taskStorage.get(taskId.trim());
    if (!existingTask) {
      throw new Error(`Unknown task: ${taskId.trim()}`);
    }

    if (existingTask.managerId !== manager.agentId) {
      throw new Error(`Task ${existingTask.id} does not belong to manager ${manager.agentId}`);
    }

    return this.updateTask(existingTask.id, input);
  }

  async completeTask(
    taskId: string,
    options?: {
      comment?: string;
      sourceContext?: MessageSourceContext;
    }
  ): Promise<UserTask> {
    const normalizedTaskId = taskId.trim();
    if (normalizedTaskId.length === 0) {
      throw new Error("complete_task taskId must be a non-empty string");
    }

    const existingTask = this.taskStorage.get(normalizedTaskId);
    if (!existingTask) {
      throw new Error(`Unknown task: ${normalizedTaskId}`);
    }

    if (existingTask.status === "completed") {
      return existingTask;
    }

    const normalizedComment = normalizeOptionalMetadataValue(options?.comment);
    if (normalizedComment) {
      await this.taskStorage.addComment(normalizedTaskId, normalizedComment);
    }

    const sourceContext = normalizeMessageSourceContext(options?.sourceContext ?? { channel: "web" });
    await this.handleUserMessage(
      formatTaskCompletionMessage(existingTask.title),
      {
        targetAgentId: existingTask.managerId,
        sourceContext
      }
    );

    const completedTask = await this.taskStorage.complete(normalizedTaskId, {
      completionEntryBody: "User completed this task."
    });

    this.logDebug("task:complete", {
      managerId: completedTask.managerId,
      taskId: completedTask.id,
      hasComment: Boolean(normalizedComment)
    });
    this.emitTaskUpdated(completedTask);

    return completedTask;
  }

  async closeTaskForManager(
    managerId: string,
    taskId: string,
    options?: {
      comment?: string;
    }
  ): Promise<UserTask> {
    const manager = this.assertManager(managerId, "manage tasks");
    const normalizedTaskId = taskId.trim();
    if (normalizedTaskId.length === 0) {
      throw new Error("task id must be a non-empty string");
    }

    const existingTask = this.taskStorage.get(normalizedTaskId);
    if (!existingTask) {
      throw new Error(`Unknown task: ${normalizedTaskId}`);
    }

    if (existingTask.managerId !== manager.agentId) {
      throw new Error(`Task ${existingTask.id} does not belong to manager ${manager.agentId}`);
    }

    if (existingTask.status === "completed") {
      return existingTask;
    }

    const normalizedComment = normalizeOptionalMetadataValue(options?.comment);
    const completedTask = await this.taskStorage.complete(normalizedTaskId, {
      comment: normalizedComment,
      completionEntryBody: normalizedComment ?? "Task closed by manager."
    });

    this.logDebug("task:close", {
      managerId: completedTask.managerId,
      taskId: completedTask.id,
      hasComment: Boolean(normalizedComment)
    });
    this.emitTaskUpdated(completedTask);

    return completedTask;
  }

  getAgent(agentId: string): AgentDescriptor | undefined {
    const descriptor = this.descriptors.get(agentId);
    if (!descriptor) {
      return undefined;
    }

    return cloneDescriptor(descriptor);
  }

  async listDirectories(path?: string): Promise<DirectoryListingResult> {
    return listDirectories(path, this.getCwdPolicy());
  }

  async validateDirectory(path: string): Promise<DirectoryValidationResult> {
    return validateDirectoryInput(path, this.getCwdPolicy());
  }

  async pickDirectory(defaultPath?: string): Promise<string | null> {
    const pickedPath = await pickNativeDirectory({
      defaultPath,
      prompt: "Select a manager working directory"
    });

    if (!pickedPath) {
      return null;
    }

    return validateDirectoryPath(pickedPath, this.getCwdPolicy());
  }

  private resolveActivityManagerContextIds(...agents: AgentDescriptor[]): string[] {
    const managerContextIds = new Set<string>();

    for (const descriptor of agents) {
      if (descriptor.role === "manager") {
        managerContextIds.add(descriptor.agentId);
        continue;
      }

      const managerId = descriptor.managerId.trim();
      if (managerId.length > 0) {
        managerContextIds.add(managerId);
      }
    }

    return Array.from(managerContextIds);
  }

  async sendMessage(
    fromAgentId: string,
    targetAgentId: string,
    message: string,
    delivery: RequestedDeliveryMode = "auto",
    options?: { origin?: "user" | "internal"; attachments?: ConversationAttachment[] }
  ): Promise<SendMessageReceipt> {
    const sender = this.descriptors.get(fromAgentId);
    if (!sender || isNonRunningAgentStatus(sender.status)) {
      throw new Error(`Unknown or unavailable sender agent: ${fromAgentId}`);
    }

    const target = this.descriptors.get(targetAgentId);
    if (!target) {
      throw new Error(`Unknown target agent: ${targetAgentId}`);
    }
    if (isNonRunningAgentStatus(target.status)) {
      throw new Error(`Target agent is not running: ${targetAgentId}`);
    }

    if (sender.role === "manager" && target.role === "worker" && target.managerId !== sender.agentId) {
      throw new Error(`Manager ${sender.agentId} does not own worker ${targetAgentId}`);
    }

    const managerContextIds = this.resolveActivityManagerContextIds(sender, target);
    const runtime = await this.getOrCreateRuntimeForDescriptor(target);

    const origin = options?.origin ?? "internal";
    const attachments = normalizeConversationAttachments(options?.attachments);
    const modelMessage = await this.prepareModelInboundMessage(
      targetAgentId,
      {
        text: message,
        attachments
      },
      origin
    );
    const receipt = await runtime.sendMessage(modelMessage, delivery);

    this.logDebug("agent:send_message", {
      fromAgentId,
      targetAgentId,
      origin,
      requestedDelivery: delivery,
      acceptedMode: receipt.acceptedMode,
      textPreview: previewForLog(message),
      attachmentCount: attachments.length,
      modelTextPreview: previewForLog(extractRuntimeMessageText(modelMessage))
    });

    if (origin !== "user" && fromAgentId !== targetAgentId) {
      for (const managerContextId of managerContextIds) {
        this.emitAgentMessage({
          type: "agent_message",
          agentId: managerContextId,
          timestamp: this.now(),
          source: "agent_to_agent",
          fromAgentId,
          toAgentId: targetAgentId,
          text: message,
          requestedDelivery: delivery,
          acceptedMode: receipt.acceptedMode,
          attachmentCount: attachments.length > 0 ? attachments.length : undefined
        });
      }
    }

    return receipt;
  }

  private async prepareModelInboundMessage(
    targetAgentId: string,
    input: { text: string; attachments: ConversationAttachment[] },
    origin: "user" | "internal"
  ): Promise<string | RuntimeUserMessage> {
    let text = input.text;

    if (origin !== "user") {
      if (text.trim().length > 0 && !/^system:/i.test(text.trimStart())) {
        text = `${INTERNAL_MODEL_MESSAGE_PREFIX}${text}`;
      }
    }

    const runtimeAttachments = await this.prepareRuntimeAttachments(targetAgentId, input.attachments);

    if (runtimeAttachments.attachmentMessage.length > 0) {
      text = text.trim().length > 0 ? `${text}\n\n${runtimeAttachments.attachmentMessage}` : runtimeAttachments.attachmentMessage;
    }

    if (runtimeAttachments.images.length === 0) {
      return text;
    }

    return {
      text,
      images: runtimeAttachments.images
    };
  }

  private async prepareRuntimeAttachments(
    targetAgentId: string,
    attachments: ConversationAttachment[]
  ): Promise<{ images: RuntimeImageAttachment[]; attachmentMessage: string }> {
    if (attachments.length === 0) {
      return {
        images: [],
        attachmentMessage: ""
      };
    }

    const images = toRuntimeImageAttachments(attachments);
    const fileMessages: string[] = [];
    const attachmentPathMessages: string[] = [];
    let binaryAttachmentDir: string | undefined;

    for (let index = 0; index < attachments.length; index += 1) {
      const attachment = attachments[index];
      const persistedPath = normalizeOptionalAttachmentPath(attachment.filePath);

      if (isConversationImageAttachment(attachment)) {
        continue;
      }

      if (persistedPath) {
        attachmentPathMessages.push(`[Attached file saved to: ${persistedPath}]`);
      }

      if (isConversationTextAttachment(attachment)) {
        fileMessages.push(formatTextAttachmentForPrompt(attachment, index + 1));
        continue;
      }

      if (isConversationBinaryAttachment(attachment)) {
        let storedPath = persistedPath;
        if (!storedPath) {
          const directory = binaryAttachmentDir ?? (await this.createBinaryAttachmentDir(targetAgentId));
          binaryAttachmentDir = directory;
          storedPath = await this.writeBinaryAttachmentToDisk(directory, attachment, index + 1, "bin");
        }
        fileMessages.push(formatBinaryAttachmentForPrompt(attachment, storedPath, index + 1));
      }
    }

    if (fileMessages.length === 0 && attachmentPathMessages.length === 0) {
      return {
        images,
        attachmentMessage: ""
      };
    }

    const attachmentMessageSections: string[] = [];
    if (fileMessages.length > 0) {
      attachmentMessageSections.push("The user attached the following files:", "", ...fileMessages);
    }
    if (attachmentPathMessages.length > 0) {
      if (attachmentMessageSections.length > 0) {
        attachmentMessageSections.push("");
      }
      attachmentMessageSections.push(...attachmentPathMessages);
    }

    return {
      images,
      attachmentMessage: attachmentMessageSections.join("\n")
    };
  }

  private async createBinaryAttachmentDir(targetAgentId: string): Promise<string> {
    const agentSegment = sanitizePathSegment(targetAgentId, "agent");
    const batchId = `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
    const directory = join(this.config.paths.dataDir, "attachments", agentSegment, batchId);
    await mkdir(directory, { recursive: true });
    return directory;
  }

  private async writeBinaryAttachmentToDisk(
    directory: string,
    attachment: Pick<ConversationBinaryAttachment, "data" | "fileName">,
    attachmentIndex: number,
    fallbackExtension: string
  ): Promise<string> {
    const safeName = sanitizeAttachmentFileName(
      attachment.fileName,
      `attachment-${attachmentIndex}.${fallbackExtension}`
    );
    const filePath = join(directory, `${String(attachmentIndex).padStart(2, "0")}-${safeName}`);
    const buffer = Buffer.from(attachment.data, "base64");
    await writeFile(filePath, buffer);
    return filePath;
  }

  private async writeTextAttachmentToDisk(
    directory: string,
    attachment: ConversationTextAttachment,
    attachmentIndex: number
  ): Promise<string> {
    const safeName = sanitizeAttachmentFileName(attachment.fileName, `attachment-${attachmentIndex}.txt`);
    const filePath = join(directory, `${String(attachmentIndex).padStart(2, "0")}-${safeName}`);
    await writeFile(filePath, attachment.text, "utf8");
    return filePath;
  }

  private async persistConversationAttachmentsIfNeeded(
    targetAgentId: string,
    attachments: ConversationAttachment[]
  ): Promise<ConversationAttachment[]> {
    if (attachments.length === 0) {
      return [];
    }

    const persisted: ConversationAttachment[] = [];
    let attachmentDir: string | undefined;

    for (let index = 0; index < attachments.length; index += 1) {
      const attachment = attachments[index];
      const attachmentIndex = index + 1;
      const persistedPath = normalizeOptionalAttachmentPath(attachment.filePath);

      if (persistedPath) {
        persisted.push({
          ...attachment,
          filePath: persistedPath
        });
        continue;
      }

      const directory = attachmentDir ?? (await this.createBinaryAttachmentDir(targetAgentId));
      attachmentDir = directory;

      if (isConversationTextAttachment(attachment)) {
        const filePath = await this.writeTextAttachmentToDisk(directory, attachment, attachmentIndex);
        persisted.push({
          ...attachment,
          filePath
        });
        continue;
      }

      if (isConversationBinaryAttachment(attachment)) {
        const filePath = await this.writeBinaryAttachmentToDisk(directory, attachment, attachmentIndex, "bin");
        persisted.push({
          ...attachment,
          filePath
        });
        continue;
      }

      if (isConversationImageAttachment(attachment)) {
        const filePath = await this.writeBinaryAttachmentToDisk(directory, attachment, attachmentIndex, "png");
        persisted.push({
          ...attachment,
          filePath
        });
      }
    }

    return persisted;
  }

  async publishToUser(
    agentId: string,
    text: string,
    source: "speak_to_user" | "system" = "speak_to_user",
    targetContext?: MessageTargetContext
  ): Promise<{ targetContext: MessageSourceContext }> {
    let resolvedTargetContext: MessageSourceContext;

    if (source === "speak_to_user") {
      this.assertManager(agentId, "speak to user");
      resolvedTargetContext = this.resolveReplyTargetContext(targetContext);
    } else {
      resolvedTargetContext = normalizeMessageSourceContext(targetContext ?? { channel: "web" });
    }

    const payload: ConversationMessageEvent = {
      type: "conversation_message",
      agentId,
      role: source === "system" ? "system" : "assistant",
      text,
      timestamp: this.now(),
      source,
      sourceContext: resolvedTargetContext
    };

    this.emitConversationMessage(payload);
    this.logDebug("manager:publish_to_user", {
      source,
      agentId,
      targetContext: resolvedTargetContext,
      textPreview: previewForLog(text)
    });

    return {
      targetContext: resolvedTargetContext
    };
  }

  async compactAgentContext(
    agentId: string,
    options?: {
      customInstructions?: string;
      sourceContext?: MessageSourceContext;
      trigger?: "api" | "slash_command";
    }
  ): Promise<unknown> {
    const descriptor = this.descriptors.get(agentId);
    if (!descriptor) {
      throw new Error(`Unknown target agent: ${agentId}`);
    }

    if (isNonRunningAgentStatus(descriptor.status)) {
      throw new Error(`Target agent is not running: ${agentId}`);
    }

    if (descriptor.role !== "manager") {
      throw new Error(`Compaction is only supported for manager agents: ${agentId}`);
    }

    const runtime = await this.getOrCreateRuntimeForDescriptor(descriptor);

    const sourceContext = normalizeMessageSourceContext(options?.sourceContext ?? { channel: "web" });
    const customInstructions = options?.customInstructions?.trim() || undefined;

    this.logDebug("manager:compact:start", {
      agentId,
      trigger: options?.trigger ?? "api",
      sourceContext,
      customInstructionsPreview: previewForLog(customInstructions ?? "")
    });

    this.emitConversationMessage({
      type: "conversation_message",
      agentId,
      role: "system",
      text: "Compacting manager context...",
      timestamp: this.now(),
      source: "system",
      sourceContext
    });

    try {
      const result = await runtime.compact(customInstructions);

      this.emitConversationMessage({
        type: "conversation_message",
        agentId,
        role: "system",
        text: "Compaction complete.",
        timestamp: this.now(),
        source: "system",
        sourceContext
      });

      this.logDebug("manager:compact:complete", {
        agentId,
        trigger: options?.trigger ?? "api"
      });

      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      this.emitConversationMessage({
        type: "conversation_message",
        agentId,
        role: "system",
        text: `Compaction failed: ${message}`,
        timestamp: this.now(),
        source: "system",
        sourceContext
      });

      this.logDebug("manager:compact:error", {
        agentId,
        trigger: options?.trigger ?? "api",
        message
      });

      throw error;
    }
  }

  async handleUserMessage(
    text: string,
    options?: {
      targetAgentId?: string;
      delivery?: RequestedDeliveryMode;
      attachments?: ConversationAttachment[];
      sourceContext?: MessageSourceContext;
    }
  ): Promise<void> {
    const trimmed = text.trim();
    const attachments = normalizeConversationAttachments(options?.attachments);
    if (!trimmed && attachments.length === 0) return;

    const sourceContext = normalizeMessageSourceContext(options?.sourceContext ?? { channel: "web" });

    const targetAgentId = options?.targetAgentId ?? this.resolvePreferredManagerId();
    if (!targetAgentId) {
      throw new Error("No manager is available. Create a manager first.");
    }
    const target = this.descriptors.get(targetAgentId);
    if (!target) {
      throw new Error(`Unknown target agent: ${targetAgentId}`);
    }
    if (isNonRunningAgentStatus(target.status)) {
      throw new Error(`Target agent is not running: ${targetAgentId}`);
    }

    const persistedAttachments = await this.persistConversationAttachmentsIfNeeded(targetAgentId, attachments);
    const attachmentMetadata = toConversationAttachmentMetadata(persistedAttachments);

    const compactCommand =
      target.role === "manager" && persistedAttachments.length === 0 ? parseCompactSlashCommand(trimmed) : undefined;
    if (compactCommand) {
      this.logDebug("manager:user_message_compact_command", {
        targetAgentId: target.agentId,
        sourceContext,
        customInstructionsPreview: previewForLog(compactCommand.customInstructions ?? "")
      });
      await this.compactAgentContext(target.agentId, {
        customInstructions: compactCommand.customInstructions,
        sourceContext,
        trigger: "slash_command"
      });
      return;
    }

    const managerContextId = target.role === "manager" ? target.agentId : target.managerId;
    const receivedAt = this.now();

    this.logDebug("manager:user_message_received", {
      targetAgentId,
      managerContextId,
      sourceContext,
      textPreview: previewForLog(trimmed),
      attachmentCount: persistedAttachments.length
    });

    const userEvent: ConversationMessageEvent = {
      type: "conversation_message",
      agentId: targetAgentId,
      role: "user",
      text: trimmed,
      attachments: attachmentMetadata.length > 0 ? attachmentMetadata : undefined,
      timestamp: receivedAt,
      source: "user_input",
      sourceContext
    };
    this.emitConversationMessage(userEvent);

    if (target.role !== "manager") {
      const requestedDelivery = options?.delivery ?? "auto";
      let receipt: SendMessageReceipt;
      try {
        receipt = await this.sendMessage(managerContextId, targetAgentId, trimmed, requestedDelivery, {
          origin: "user",
          attachments: persistedAttachments
        });
      } catch (error) {
        this.logDebug("manager:user_message_dispatch_error", {
          managerContextId,
          targetAgentId,
          targetRole: target.role,
          requestedDelivery,
          sourceContext,
          textPreview: previewForLog(trimmed),
          attachmentCount: persistedAttachments.length,
          message: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined
        });
        throw error;
      }

      this.logDebug("manager:user_message_dispatch_complete", {
        managerContextId,
        targetAgentId,
        targetRole: target.role,
        requestedDelivery,
        acceptedMode: receipt.acceptedMode,
        sourceContext,
        attachmentCount: persistedAttachments.length
      });

      this.emitAgentMessage({
        type: "agent_message",
        agentId: managerContextId,
        timestamp: this.now(),
        source: "user_to_agent",
        toAgentId: targetAgentId,
        text: trimmed,
        sourceContext,
        requestedDelivery,
        acceptedMode: receipt.acceptedMode,
        attachmentCount: persistedAttachments.length > 0 ? persistedAttachments.length : undefined
      });
      return;
    }

    let managerRuntime: SwarmAgentRuntime;
    try {
      managerRuntime = await this.getOrCreateRuntimeForDescriptor(target);
    } catch (error) {
      this.logDebug("manager:user_message_dispatch_error", {
        managerContextId,
        targetAgentId: managerContextId,
        targetRole: target.role,
        requestedDelivery: "steer",
        sourceContext,
        textPreview: previewForLog(trimmed),
        attachmentCount: persistedAttachments.length,
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined
      });
      throw error;
    }

    const managerVisibleMessage = formatInboundUserMessageForManager(trimmed, sourceContext);

    // User messages to managers should always steer in-flight work.
    const runtimeMessage = await this.prepareModelInboundMessage(
      managerContextId,
      {
        text: managerVisibleMessage,
        attachments: persistedAttachments
      },
      "user"
    );

    this.logDebug("manager:user_message_dispatch_start", {
      managerContextId,
      targetAgentId: managerContextId,
      targetRole: target.role,
      requestedDelivery: "steer",
      sourceContext,
      textPreview: previewForLog(trimmed),
      attachmentCount: persistedAttachments.length,
      runtimeTextPreview: previewForLog(extractRuntimeMessageText(runtimeMessage)),
      runtimeImageCount: typeof runtimeMessage === "string" ? 0 : (runtimeMessage.images?.length ?? 0)
    });

    try {
      const receipt = await managerRuntime.sendMessage(runtimeMessage, "steer");
      this.logDebug("manager:user_message_dispatch_complete", {
        managerContextId,
        targetAgentId: managerContextId,
        targetRole: target.role,
        requestedDelivery: "steer",
        acceptedMode: receipt.acceptedMode,
        sourceContext,
        attachmentCount: persistedAttachments.length
      });
    } catch (error) {
      this.logDebug("manager:user_message_dispatch_error", {
        managerContextId,
        targetAgentId: managerContextId,
        targetRole: target.role,
        requestedDelivery: "steer",
        sourceContext,
        textPreview: previewForLog(trimmed),
        attachmentCount: persistedAttachments.length,
        runtimeTextPreview: previewForLog(extractRuntimeMessageText(runtimeMessage)),
        runtimeImageCount: typeof runtimeMessage === "string" ? 0 : (runtimeMessage.images?.length ?? 0),
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined
      });
      throw error;
    }
  }

  async resetManagerSession(
    managerIdOrReason: string | "user_new_command" | "api_reset" = "api_reset",
    maybeReason?: "user_new_command" | "api_reset"
  ): Promise<void> {
    const parsed = this.parseResetManagerSessionArgs(managerIdOrReason, maybeReason);
    const managerId = parsed.managerId;
    const reason = parsed.reason;
    const managerDescriptor = this.getRequiredManagerDescriptor(managerId);

    this.logDebug("manager:reset:start", {
      managerId,
      reason,
      sessionFile: managerDescriptor.sessionFile
    });

    const existingRuntime = this.runtimes.get(managerId);
    if (existingRuntime) {
      await existingRuntime.terminate({ abort: true });
      this.runtimes.delete(managerId);
    }

    this.conversationProjector.resetConversationHistory(managerId);
    await this.deleteManagerSessionFile(managerDescriptor.sessionFile);

    managerDescriptor.status = transitionAgentStatus(managerDescriptor.status, "idle");
    managerDescriptor.contextUsage = undefined;
    managerDescriptor.updatedAt = this.now();
    this.descriptors.set(managerId, managerDescriptor);
    await this.saveStore();

    const managerRuntime = await this.createRuntimeForDescriptor(
      managerDescriptor,
      this.resolveSystemPromptForDescriptor(managerDescriptor)
    );
    this.runtimes.set(managerId, managerRuntime);

    const contextUsage = managerRuntime.getContextUsage();
    managerDescriptor.contextUsage = contextUsage;

    this.emitConversationReset(managerId, reason);
    this.emitStatus(managerId, managerDescriptor.status, managerRuntime.getPendingCount(), contextUsage);
    this.emitAgentsSnapshot();

    this.logDebug("manager:reset:ready", {
      managerId,
      reason,
      sessionFile: managerDescriptor.sessionFile
    });
  }

  getConfig(): SwarmConfig {
    return this.config;
  }

  async listSettingsEnv(): Promise<SkillEnvRequirement[]> {
    return this.secretsEnvService.listSettingsEnv();
  }

  async updateSettingsEnv(values: Record<string, string>): Promise<void> {
    await this.secretsEnvService.updateSettingsEnv(values);
  }

  async deleteSettingsEnv(name: string): Promise<void> {
    await this.secretsEnvService.deleteSettingsEnv(name);
  }

  async listSettingsAuth(): Promise<SettingsAuthProvider[]> {
    return this.secretsEnvService.listSettingsAuth();
  }

  async updateSettingsAuth(values: Record<string, string>): Promise<void> {
    await this.secretsEnvService.updateSettingsAuth(values);
  }

  async deleteSettingsAuth(provider: string): Promise<void> {
    await this.secretsEnvService.deleteSettingsAuth(provider);
  }

  private emitConversationMessage(event: ConversationMessageEvent): void {
    this.conversationProjector.emitConversationMessage(event);
  }

  private emitAgentMessage(event: AgentMessageEvent): void {
    this.conversationProjector.emitAgentMessage(event);
  }

  private emitConversationReset(agentId: string, reason: "user_new_command" | "api_reset"): void {
    this.conversationProjector.emitConversationReset(agentId, reason);
  }

  private logDebug(message: string, details?: unknown): void {
    if (!this.config.debug) return;

    const prefix = `[swarm][${this.now()}] ${message}`;
    if (details === undefined) {
      console.log(prefix);
      return;
    }
    console.log(prefix, details);
  }

  private getConfiguredManagerId(): string | undefined {
    return normalizeOptionalAgentId(this.config.managerId);
  }

  private resolvePreferredManagerId(options?: { includeStoppedOnRestart?: boolean }): string | undefined {
    const includeStoppedOnRestart = options?.includeStoppedOnRestart ?? false;
    const configuredManagerId = this.getConfiguredManagerId();
    if (configuredManagerId) {
      const configuredManager = this.descriptors.get(configuredManagerId);
      if (configuredManager && this.isAvailableManagerDescriptor(configuredManager, includeStoppedOnRestart)) {
        return configuredManagerId;
      }
    }

    const firstManager = Array.from(this.descriptors.values())
      .filter((descriptor) => this.isAvailableManagerDescriptor(descriptor, includeStoppedOnRestart))
      .sort((left, right) => {
        if (left.createdAt !== right.createdAt) {
          return left.createdAt.localeCompare(right.createdAt);
        }
        return left.agentId.localeCompare(right.agentId);
      })[0];

    return firstManager?.agentId;
  }

  private isAvailableManagerDescriptor(
    descriptor: AgentDescriptor,
    includeStoppedOnRestart: boolean
  ): boolean {
    if (descriptor.role !== "manager") {
      return false;
    }

    if (descriptor.status === "terminated" || descriptor.status === "error") {
      return false;
    }

    if (!includeStoppedOnRestart && descriptor.status === "stopped") {
      return false;
    }

    return true;
  }

  private sortedDescriptors(): AgentDescriptor[] {
    const configuredManagerId = this.getConfiguredManagerId();
    return Array.from(this.descriptors.values()).sort((a, b) => {
      if (configuredManagerId) {
        if (a.agentId === configuredManagerId) return -1;
        if (b.agentId === configuredManagerId) return 1;
      }

      if (a.role === "manager" && b.role !== "manager") return -1;
      if (b.role === "manager" && a.role !== "manager") return 1;

      if (a.createdAt !== b.createdAt) {
        return a.createdAt.localeCompare(b.createdAt);
      }

      return a.agentId.localeCompare(b.agentId);
    });
  }

  private async sendManagerBootstrapMessage(managerId: string): Promise<void> {
    const manager = this.descriptors.get(managerId);
    if (!manager || manager.role !== "manager") {
      return;
    }

    if (isNonRunningAgentStatus(manager.status)) {
      return;
    }

    if (!this.runtimes.has(managerId)) {
      return;
    }

    try {
      await this.sendMessage(managerId, managerId, MANAGER_BOOTSTRAP_INTERVIEW_MESSAGE, "auto", {
        origin: "internal"
      });
      this.logDebug("manager:bootstrap_message:sent", { managerId });
    } catch (error) {
      this.logDebug("manager:bootstrap_message:error", {
        managerId,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private normalizeStreamingStatusesForBoot(): void {
    const normalizedAgentIds: string[] = [];

    for (const descriptor of this.descriptors.values()) {
      if (descriptor.status !== "streaming") {
        continue;
      }

      descriptor.status = transitionAgentStatus(descriptor.status, "idle");
      descriptor.updatedAt = this.now();
      this.descriptors.set(descriptor.agentId, descriptor);
      normalizedAgentIds.push(descriptor.agentId);
    }

    if (normalizedAgentIds.length > 0) {
      this.logDebug("boot:normalize_streaming_statuses", { normalizedAgentIds });
    }
  }

  private async restoreRuntimesForBoot(): Promise<void> {
    let shouldPersist = false;
    const configuredManagerId = this.getConfiguredManagerId();

    for (const descriptor of this.sortedDescriptors()) {
      if (!this.shouldRestoreRuntimeForDescriptor(descriptor)) {
        continue;
      }

      try {
        await this.getOrCreateRuntimeForDescriptor(descriptor);
      } catch (error) {
        if (
          descriptor.role === "manager" &&
          configuredManagerId &&
          descriptor.agentId === configuredManagerId
        ) {
          throw error;
        }

        const idleStatus = descriptor.status === "streaming"
          ? transitionAgentStatus(descriptor.status, "idle")
          : descriptor.status;
        descriptor.status = transitionAgentStatus(idleStatus, "stopped");
        descriptor.contextUsage = undefined;
        descriptor.updatedAt = this.now();
        this.descriptors.set(descriptor.agentId, descriptor);
        shouldPersist = true;

        this.emitStatus(descriptor.agentId, descriptor.status, 0);
        this.logDebug("boot:restore_runtime:error", {
          agentId: descriptor.agentId,
          role: descriptor.role,
          message: error instanceof Error ? error.message : String(error)
        });
      }
    }

    if (shouldPersist) {
      await this.saveStore();
    }

    if (configuredManagerId) {
      const primaryManager = this.descriptors.get(configuredManagerId);
      if (
        primaryManager &&
        primaryManager.role === "manager" &&
        primaryManager.status === "streaming" &&
        !this.runtimes.has(configuredManagerId)
      ) {
        throw new Error("Primary manager runtime is not initialized");
      }
    }
  }

  private shouldRestoreRuntimeForDescriptor(descriptor: AgentDescriptor): boolean {
    return descriptor.status === "streaming";
  }

  private async getOrCreateRuntimeForDescriptor(descriptor: AgentDescriptor): Promise<SwarmAgentRuntime> {
    const existingRuntime = this.runtimes.get(descriptor.agentId);
    if (existingRuntime) {
      return existingRuntime;
    }

    const runtime = await this.createRuntimeForDescriptor(descriptor, this.resolveSystemPromptForDescriptor(descriptor));

    const latestDescriptor = this.descriptors.get(descriptor.agentId);
    if (!latestDescriptor || isNonRunningAgentStatus(latestDescriptor.status)) {
      await runtime.terminate({ abort: true });
      throw new Error(`Target agent is not running: ${descriptor.agentId}`);
    }

    const concurrentRuntime = this.runtimes.get(descriptor.agentId);
    if (concurrentRuntime) {
      await runtime.terminate({ abort: true });
      return concurrentRuntime;
    }

    this.runtimes.set(descriptor.agentId, runtime);
    const contextUsage = runtime.getContextUsage();
    latestDescriptor.contextUsage = contextUsage;
    this.descriptors.set(descriptor.agentId, latestDescriptor);
    this.emitStatus(descriptor.agentId, latestDescriptor.status, runtime.getPendingCount(), contextUsage);
    return runtime;
  }

  private getBootLogManagerDescriptor(): AgentDescriptor | undefined {
    const configuredManagerId = this.getConfiguredManagerId();
    if (configuredManagerId) {
      const configuredManager = this.descriptors.get(configuredManagerId);
      if (configuredManager && configuredManager.role === "manager" && configuredManager.status !== "terminated") {
        return configuredManager;
      }
    }

    return Array.from(this.descriptors.values()).find(
      (descriptor) => descriptor.role === "manager" && descriptor.status !== "terminated"
    );
  }

  private getRequiredManagerDescriptor(managerId: string): AgentDescriptor {
    const descriptor = this.descriptors.get(managerId);
    if (!descriptor || descriptor.role !== "manager") {
      throw new Error(`Unknown manager: ${managerId}`);
    }

    return descriptor;
  }

  private resolveDefaultModelDescriptor(): AgentModelDescriptor {
    return resolveModelDescriptorFromPreset(this.defaultModelPreset);
  }

  private normalizePersistedModelDescriptor(
    descriptor: Pick<AgentModelDescriptor, "provider" | "modelId"> | undefined
  ): AgentModelDescriptor {
    return normalizeSwarmModelDescriptor(descriptor, this.defaultModelPreset);
  }

  private resolveSpawnModel(
    requested: SpawnAgentInput["model"] | undefined,
    fallback: AgentModelDescriptor
  ): AgentModelDescriptor {
    const requestedPreset = parseSwarmModelPreset(requested, "spawn_agent.model");
    if (requestedPreset) {
      return resolveModelDescriptorFromPreset(requestedPreset);
    }

    return this.normalizePersistedModelDescriptor(fallback);
  }

  private resolveSpawnWorkerArchetypeId(
    input: SpawnAgentInput,
    normalizedAgentId: string
  ): string | undefined {
    if (input.archetypeId !== undefined) {
      const explicit = normalizeArchetypeId(input.archetypeId);
      if (!explicit) {
        throw new Error("spawn_agent archetypeId must include at least one letter or number");
      }
      if (!this.archetypePromptRegistry.resolvePrompt(explicit)) {
        throw new Error(`Unknown archetypeId: ${explicit}`);
      }
      return explicit;
    }

    if (
      normalizedAgentId === MERGER_ARCHETYPE_ID ||
      normalizedAgentId.startsWith(`${MERGER_ARCHETYPE_ID}-`)
    ) {
      return MERGER_ARCHETYPE_ID;
    }

    return undefined;
  }

  private resolveSystemPromptForDescriptor(descriptor: AgentDescriptor): string {
    if (descriptor.role === "manager") {
      return this.resolveRequiredArchetypePrompt(MANAGER_ARCHETYPE_ID);
    }

    if (descriptor.archetypeId) {
      const archetypePrompt = this.archetypePromptRegistry.resolvePrompt(descriptor.archetypeId);
      if (archetypePrompt) {
        return archetypePrompt;
      }
    }

    return DEFAULT_WORKER_SYSTEM_PROMPT;
  }

  private resolveRequiredArchetypePrompt(archetypeId: string): string {
    const prompt = this.archetypePromptRegistry.resolvePrompt(archetypeId);
    if (!prompt) {
      throw new Error(`Missing archetype prompt: ${archetypeId}`);
    }
    return prompt;
  }

  private async resolveAndValidateCwd(cwd: string): Promise<string> {
    return validateDirectoryPath(cwd, this.getCwdPolicy());
  }

  private getCwdPolicy(): { rootDir: string; allowlistRoots: string[] } {
    return {
      rootDir: this.config.paths.rootDir,
      allowlistRoots: normalizeAllowlistRoots(this.config.cwdAllowlistRoots)
    };
  }

  private generateUniqueAgentId(source: string): string {
    const base = normalizeAgentId(source);

    if (!base) {
      throw new Error("spawn_agent agentId must include at least one letter or number");
    }

    const configuredManagerId = this.getConfiguredManagerId();
    if (configuredManagerId && base === configuredManagerId) {
      throw new Error(`spawn_agent agentId \"${configuredManagerId}\" is reserved`);
    }

    if (!this.descriptors.has(base)) {
      return base;
    }

    let index = 2;
    while (this.descriptors.has(`${base}-${index}`)) {
      index += 1;
    }

    return `${base}-${index}`;
  }

  private generateUniqueManagerId(source: string): string {
    const base = normalizeAgentId(source);
    if (!base) {
      throw new Error("create_manager name must include at least one letter or number");
    }

    if (!this.descriptors.has(base)) {
      return base;
    }

    let index = 2;
    while (this.descriptors.has(`${base}-${index}`)) {
      index += 1;
    }

    return `${base}-${index}`;
  }

  private assertManager(agentId: string, action: string): AgentDescriptor {
    const descriptor = this.descriptors.get(agentId);
    if (!descriptor || descriptor.role !== "manager") {
      throw new Error(`Only manager can ${action}`);
    }

    if (isNonRunningAgentStatus(descriptor.status)) {
      throw new Error(`Manager is not running: ${agentId}`);
    }

    return descriptor;
  }

  private hasRunningManagers(): boolean {
    for (const descriptor of this.descriptors.values()) {
      if (descriptor.role !== "manager") {
        continue;
      }

      if (isNonRunningAgentStatus(descriptor.status)) {
        continue;
      }

      return true;
    }

    return false;
  }

  private resolveReplyTargetContext(explicitTargetContext?: MessageTargetContext): MessageSourceContext {
    if (!explicitTargetContext) {
      return { channel: "web" };
    }

    const normalizedExplicitTarget = normalizeMessageTargetContext(explicitTargetContext);

    if (
      (normalizedExplicitTarget.channel === "slack" ||
        normalizedExplicitTarget.channel === "telegram") &&
      !normalizedExplicitTarget.channelId
    ) {
      throw new Error(
        'speak_to_user target.channelId is required when target.channel is "slack" or "telegram"'
      );
    }

    return normalizeMessageSourceContext(normalizedExplicitTarget);
  }

  private parseResetManagerSessionArgs(
    managerIdOrReason: string | "user_new_command" | "api_reset",
    maybeReason?: "user_new_command" | "api_reset"
  ): { managerId: string; reason: "user_new_command" | "api_reset" } {
    if (managerIdOrReason === "user_new_command" || managerIdOrReason === "api_reset") {
      const managerId = this.resolvePreferredManagerId({ includeStoppedOnRestart: true });
      if (!managerId) {
        throw new Error("No manager is available.");
      }

      return {
        managerId,
        reason: managerIdOrReason
      };
    }

    return {
      managerId: managerIdOrReason,
      reason: maybeReason ?? "api_reset"
    };
  }

  private async terminateDescriptor(
    descriptor: AgentDescriptor,
    options: { abort: boolean; emitStatus: boolean }
  ): Promise<void> {
    const runtime = this.runtimes.get(descriptor.agentId);
    if (runtime) {
      await runtime.terminate({ abort: options.abort });
      this.runtimes.delete(descriptor.agentId);
    }

    descriptor.status = transitionAgentStatus(descriptor.status, "terminated");
    descriptor.contextUsage = undefined;
    descriptor.updatedAt = this.now();
    this.descriptors.set(descriptor.agentId, descriptor);

    if (options.emitStatus) {
      this.emitStatus(descriptor.agentId, descriptor.status, 0);
    }
  }

  protected async getMemoryRuntimeResources(descriptor: AgentDescriptor): Promise<{
    memoryContextFile: { path: string; content: string };
    additionalSkillPaths: string[];
  }> {
    await this.ensureAgentMemoryFile(descriptor.agentId);

    const memoryOwnerAgentId = this.resolveMemoryOwnerAgentId(descriptor);
    const memoryFilePath = this.getAgentMemoryPath(memoryOwnerAgentId);
    await this.ensureAgentMemoryFile(memoryOwnerAgentId);

    await this.skillMetadataService.ensureSkillMetadataLoaded();

    const memoryContextFile = {
      path: memoryFilePath,
      content: await readFile(memoryFilePath, "utf8")
    };

    return {
      memoryContextFile,
      additionalSkillPaths: this.skillMetadataService.getAdditionalSkillPaths()
    };
  }

  private async reloadSkillMetadata(): Promise<void> {
    await this.skillMetadataService.reloadSkillMetadata();
  }

  private async loadSecretsStore(): Promise<void> {
    await this.secretsEnvService.loadSecretsStore();
  }

  protected async getSwarmContextFiles(cwd: string): Promise<Array<{ path: string; content: string }>> {
    const contextFiles: Array<{ path: string; content: string }> = [];
    const seenPaths = new Set<string>();
    const rootDir = resolve("/");
    let currentDir = resolve(cwd);

    while (true) {
      const candidatePath = join(currentDir, SWARM_CONTEXT_FILE_NAME);
      if (!seenPaths.has(candidatePath) && existsSync(candidatePath)) {
        try {
          contextFiles.unshift({
            path: candidatePath,
            content: await readFile(candidatePath, "utf8")
          });
          seenPaths.add(candidatePath);
        } catch (error) {
          this.logDebug("runtime:swarm_context:read:error", {
            cwd,
            path: candidatePath,
            message: error instanceof Error ? error.message : String(error)
          });
        }
      }

      if (currentDir === rootDir) {
        break;
      }

      const parentDir = resolve(currentDir, "..");
      if (parentDir === currentDir) {
        break;
      }
      currentDir = parentDir;
    }

    return contextFiles;
  }

  private mergeRuntimeContextFiles(
    baseAgentsFiles: Array<{ path: string; content: string }>,
    options: {
      memoryContextFile: { path: string; content: string };
      swarmContextFiles: Array<{ path: string; content: string }>;
    }
  ): Array<{ path: string; content: string }> {
    const swarmContextPaths = new Set(options.swarmContextFiles.map((entry) => entry.path));
    const withoutSwarmAndMemory = baseAgentsFiles.filter(
      (entry) => entry.path !== options.memoryContextFile.path && !swarmContextPaths.has(entry.path)
    );

    return [...withoutSwarmAndMemory, ...options.swarmContextFiles, options.memoryContextFile];
  }

  protected async createRuntimeForDescriptor(
    descriptor: AgentDescriptor,
    systemPrompt: string
  ): Promise<SwarmAgentRuntime> {
    return this.runtimeFactory.createRuntimeForDescriptor(descriptor, systemPrompt);
  }

  private async handleRuntimeStatus(
    agentId: string,
    status: AgentStatus,
    pendingCount: number,
    contextUsage?: AgentContextUsage
  ): Promise<void> {
    const descriptor = this.descriptors.get(agentId);
    if (!descriptor) return;

    const normalizedContextUsage = normalizeContextUsage(contextUsage);
    let shouldPersist = false;

    if (!areContextUsagesEqual(descriptor.contextUsage, normalizedContextUsage)) {
      descriptor.contextUsage = normalizedContextUsage;
    }

    const nextStatus = transitionAgentStatus(descriptor.status, status);
    if (descriptor.status !== nextStatus) {
      descriptor.status = nextStatus;
      descriptor.updatedAt = this.now();
      shouldPersist = true;
    }

    if (isNonRunningAgentStatus(nextStatus) && descriptor.contextUsage) {
      descriptor.contextUsage = undefined;
      shouldPersist = true;
    }

    this.descriptors.set(agentId, descriptor);

    if (shouldPersist) {
      await this.saveStore();
    }

    this.emitStatus(agentId, status, pendingCount, descriptor.contextUsage);
    this.logDebug("runtime:status", {
      agentId,
      status,
      pendingCount,
      contextUsage: descriptor.contextUsage
    });
  }

  private async handleRuntimeSessionEvent(agentId: string, event: RuntimeSessionEvent): Promise<void> {
    this.captureConversationEventFromRuntime(agentId, event);

    if (!this.config.debug) return;

    const descriptor = this.descriptors.get(agentId);
    if (!descriptor || descriptor.role !== "manager") {
      return;
    }

    switch (event.type) {
      case "agent_start":
      case "agent_end":
      case "turn_start":
        this.logDebug(`manager:event:${event.type}`);
        return;

      case "turn_end":
        this.logDebug("manager:event:turn_end", {
          toolResults: event.toolResults.length
        });
        return;

      case "tool_execution_start":
        this.logDebug("manager:tool:start", {
          toolName: event.toolName,
          toolCallId: event.toolCallId,
          args: previewForLog(safeJson(event.args), 240)
        });
        return;

      case "tool_execution_end":
        this.logDebug("manager:tool:end", {
          toolName: event.toolName,
          toolCallId: event.toolCallId,
          isError: event.isError,
          result: previewForLog(safeJson(event.result), 240)
        });
        return;

      case "message_start":
      case "message_end":
        this.logDebug(`manager:event:${event.type}`, {
          role: extractRole(event.message),
          textPreview: previewForLog(extractMessageText(event.message) ?? "")
        });
        return;

      case "message_update":
      case "tool_execution_update":
      case "auto_compaction_start":
      case "auto_compaction_end":
      case "auto_retry_start":
      case "auto_retry_end":
        return;
    }
  }

  private async handleRuntimeError(agentId: string, error: RuntimeErrorEvent): Promise<void> {
    const descriptor = this.descriptors.get(agentId);
    if (!descriptor) {
      return;
    }

    const message = error.message.trim().length > 0 ? error.message.trim() : "Unknown runtime error";
    const attempt = readPositiveIntegerDetail(error.details, "attempt");
    const maxAttempts = readPositiveIntegerDetail(error.details, "maxAttempts");
    const droppedPendingCount = readPositiveIntegerDetail(error.details, "droppedPendingCount");

    this.logDebug("runtime:error", {
      agentId,
      runtime: descriptor.model.provider.includes("codex-app")
        ? "codex-app-server"
        : descriptor.model.provider.includes("anthropic-claude-code")
          ? "anthropic-claude-code"
          : "pi",
      phase: error.phase,
      message,
      stack: error.stack,
      details: error.details
    });

    const retryLabel =
      attempt && maxAttempts && maxAttempts > 1 ? ` (attempt ${attempt}/${maxAttempts})` : "";

    const text =
      error.phase === "compaction"
        ? `⚠️ Compaction error${retryLabel}: ${message}. Continuing without compaction.`
        : droppedPendingCount && droppedPendingCount > 0
          ? `⚠️ Agent error${retryLabel}: ${message}. ${droppedPendingCount} queued message${droppedPendingCount === 1 ? "" : "s"} could not be delivered and were dropped. Please resend.`
          : `⚠️ Agent error${retryLabel}: ${message}. Message may need to be resent.`;

    this.emitConversationMessage({
      type: "conversation_message",
      agentId,
      role: "system",
      text,
      timestamp: this.now(),
      source: "system"
    });
  }

  private captureConversationEventFromRuntime(agentId: string, event: RuntimeSessionEvent): void {
    this.conversationProjector.captureConversationEventFromRuntime(agentId, event);
  }

  private emitStatus(
    agentId: string,
    status: AgentStatus,
    pendingCount: number,
    contextUsage?: AgentContextUsage
  ): void {
    const resolvedContextUsage = normalizeContextUsage(contextUsage ?? this.descriptors.get(agentId)?.contextUsage);
    const payload: AgentStatusEvent = {
      type: "agent_status",
      agentId,
      status,
      pendingCount,
      ...(resolvedContextUsage ? { contextUsage: resolvedContextUsage } : {})
    };

    this.emit("agent_status", payload satisfies ServerEvent);
  }

  private emitAgentsSnapshot(): void {
    const payload: AgentsSnapshotEvent = {
      type: "agents_snapshot",
      agents: this.listAgents()
    };

    this.emit("agents_snapshot", payload satisfies ServerEvent);
  }

  private emitTaskCreated(task: UserTask): void {
    this.emit("task_created", {
      type: "task_created",
      task
    } satisfies ServerEvent);
  }

  private emitTaskUpdated(task: UserTask): void {
    this.emit("task_updated", {
      type: "task_updated",
      task
    } satisfies ServerEvent);
  }

  private emitTasksDeleted(taskIds: string[]): void {
    this.emit("tasks_deleted", {
      type: "tasks_deleted",
      taskIds
    } satisfies ServerEvent);
  }

  private async handleRuntimeAgentEnd(_agentId: string): Promise<void> {
    // No-op: managers now receive all inbound messages with sourceContext metadata
    // and decide whether to respond without pending-reply bookkeeping.
  }

  private async ensureDirectories(): Promise<void> {
    await this.persistenceService.ensureDirectories();
  }

  private getAgentMemoryPath(agentId: string): string {
    return getAgentMemoryPathForDataDir(this.config.paths.dataDir, agentId);
  }

  private resolveMemoryOwnerAgentId(descriptor: AgentDescriptor): string {
    if (descriptor.role === "manager") {
      return descriptor.agentId;
    }

    const managerId = normalizeOptionalAgentId(descriptor.managerId);
    if (managerId) {
      return managerId;
    }

    return this.resolvePreferredManagerId({ includeStoppedOnRestart: true }) ?? descriptor.agentId;
  }

  private async ensureMemoryFilesForBoot(): Promise<void> {
    await this.persistenceService.ensureMemoryFilesForBoot();
  }

  private async ensureAgentMemoryFile(agentId: string): Promise<void> {
    await this.persistenceService.ensureAgentMemoryFile(agentId);
  }

  private async deleteManagerSessionFile(sessionFile: string): Promise<void> {
    await this.persistenceService.deleteManagerSessionFile(sessionFile);
  }

  private async deleteManagerSchedulesFile(managerId: string): Promise<void> {
    await this.persistenceService.deleteManagerSchedulesFile(managerId);
  }

  private async loadStore(): Promise<AgentsStoreFile> {
    return this.persistenceService.loadStore();
  }

  private loadConversationHistoriesFromStore(): void {
    this.conversationProjector.loadConversationHistoriesFromStore();
  }

  private async saveStore(): Promise<void> {
    await this.persistenceService.saveStore();
  }
}

const VALID_PERSISTED_AGENT_ROLES = new Set(["manager", "worker"]);
const VALID_PERSISTED_AGENT_STATUSES = new Set([
  "idle",
  "streaming",
  "terminated",
  "stopped",
  "error",
  "stopped_on_restart"
]);

function validateAgentDescriptor(value: unknown): AgentDescriptor | string {
  if (!isRecord(value)) {
    return "descriptor must be an object";
  }

  if (!isNonEmptyString(value.agentId)) {
    return "agentId must be a non-empty string";
  }

  if (typeof value.displayName !== "string") {
    return "displayName must be a string";
  }

  if (!isNonEmptyString(value.role) || !VALID_PERSISTED_AGENT_ROLES.has(value.role)) {
    return "role must be one of manager|worker";
  }

  if (!isNonEmptyString(value.managerId)) {
    return "managerId must be a non-empty string";
  }

  if (!isNonEmptyString(value.status) || !VALID_PERSISTED_AGENT_STATUSES.has(value.status)) {
    return "status must be one of idle|streaming|terminated|stopped|error|stopped_on_restart";
  }
  const normalizedStatus = normalizeAgentStatus(value.status as AgentStatusInput);

  if (!isNonEmptyString(value.createdAt)) {
    return "createdAt must be a non-empty string";
  }

  if (!isNonEmptyString(value.updatedAt)) {
    return "updatedAt must be a non-empty string";
  }

  if (!isNonEmptyString(value.cwd)) {
    return "cwd must be a non-empty string";
  }

  if (!isNonEmptyString(value.sessionFile)) {
    return "sessionFile must be a non-empty string";
  }

  const model = value.model;
  if (!isRecord(model)) {
    return "model must be an object";
  }

  if (!isNonEmptyString(model.provider)) {
    return "model.provider must be a non-empty string";
  }

  if (!isNonEmptyString(model.modelId)) {
    return "model.modelId must be a non-empty string";
  }

  if (!isNonEmptyString(model.thinkingLevel)) {
    return "model.thinkingLevel must be a non-empty string";
  }

  if (value.archetypeId !== undefined && typeof value.archetypeId !== "string") {
    return "archetypeId must be a string when provided";
  }

  const descriptor = value as unknown as AgentDescriptor;
  if (descriptor.status === normalizedStatus) {
    return descriptor;
  }

  return {
    ...descriptor,
    status: normalizedStatus
  };
}

function extractDescriptorAgentId(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  return isNonEmptyString(value.agentId) ? value.agentId.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function normalizeAgentId(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function normalizeOptionalAgentId(input: string | undefined): string | undefined {
  if (typeof input !== "string") {
    return undefined;
  }

  const trimmed = input.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function previewForLog(text: string, maxLength = 160): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength)}...`;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function readPositiveIntegerDetail(details: Record<string, unknown> | undefined, key: string): number | undefined {
  if (!details) {
    return undefined;
  }

  const value = details[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    return undefined;
  }

  return value;
}

function normalizeConversationAttachments(
  attachments: ConversationAttachment[] | undefined
): ConversationAttachment[] {
  if (!attachments || attachments.length === 0) {
    return [];
  }

  const normalized: ConversationAttachment[] = [];

  for (const attachment of attachments) {
    if (!attachment || typeof attachment !== "object") {
      continue;
    }

    const mimeType = typeof attachment.mimeType === "string" ? attachment.mimeType.trim() : "";
    const fileName = typeof attachment.fileName === "string" ? attachment.fileName.trim() : "";
    const filePath = typeof attachment.filePath === "string" ? attachment.filePath.trim() : "";

    if (attachment.type === "text") {
      const text = typeof attachment.text === "string" ? attachment.text : "";
      if (!mimeType || text.trim().length === 0) {
        continue;
      }

      normalized.push({
        type: "text",
        mimeType,
        text,
        fileName: fileName || undefined,
        filePath: filePath || undefined
      });
      continue;
    }

    if (attachment.type === "binary") {
      const data = typeof attachment.data === "string" ? attachment.data.trim() : "";
      if (!mimeType || data.length === 0) {
        continue;
      }

      normalized.push({
        type: "binary",
        mimeType,
        data,
        fileName: fileName || undefined,
        filePath: filePath || undefined
      });
      continue;
    }

    const data = typeof attachment.data === "string" ? attachment.data.trim() : "";
    if (!mimeType || !mimeType.startsWith("image/") || !data) {
      continue;
    }

    normalized.push({
      mimeType,
      data,
      fileName: fileName || undefined,
      filePath: filePath || undefined
    });
  }

  return normalized;
}

function toConversationAttachmentMetadata(attachments: ConversationAttachment[]): ConversationAttachmentMetadata[] {
  const metadata: ConversationAttachmentMetadata[] = [];

  for (const attachment of attachments) {
    if (!attachment || typeof attachment !== "object") {
      continue;
    }

    const normalizedPath = normalizeOptionalAttachmentPath(attachment.filePath);
    const normalizedName = normalizeOptionalMetadataValue(attachment.fileName);
    const sizeBytes = computeAttachmentSizeBytes(attachment);

    if (isConversationTextAttachment(attachment)) {
      metadata.push({
        type: "text",
        mimeType: attachment.mimeType,
        fileName: normalizedName,
        filePath: normalizedPath,
        sizeBytes
      });
      continue;
    }

    if (isConversationBinaryAttachment(attachment)) {
      metadata.push({
        type: "binary",
        mimeType: attachment.mimeType,
        fileName: normalizedName,
        filePath: normalizedPath,
        sizeBytes
      });
      continue;
    }

    if (isConversationImageAttachment(attachment)) {
      metadata.push({
        type: "image",
        mimeType: attachment.mimeType,
        fileName: normalizedName,
        filePath: normalizedPath,
        sizeBytes
      });
    }
  }

  return metadata;
}

function computeAttachmentSizeBytes(attachment: ConversationAttachment): number | undefined {
  if (isConversationTextAttachment(attachment)) {
    return Buffer.byteLength(attachment.text, "utf8");
  }

  if (isConversationBinaryAttachment(attachment) || isConversationImageAttachment(attachment)) {
    return decodeBase64ByteLength(attachment.data);
  }

  return undefined;
}

function decodeBase64ByteLength(value: string): number {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return 0;
  }

  let padding = 0;
  if (trimmed.endsWith("==")) {
    padding = 2;
  } else if (trimmed.endsWith("=")) {
    padding = 1;
  }

  return Math.max(0, Math.floor((trimmed.length * 3) / 4) - padding);
}

function toRuntimeImageAttachments(attachments: ConversationAttachment[]): RuntimeImageAttachment[] {
  const images: RuntimeImageAttachment[] = [];

  for (const attachment of attachments) {
    if (!isConversationImageAttachment(attachment)) {
      continue;
    }

    images.push({
      mimeType: attachment.mimeType,
      data: attachment.data
    });
  }

  return images;
}

function formatTextAttachmentForPrompt(attachment: ConversationTextAttachment, index: number): string {
  const fileName = attachment.fileName?.trim() || `attachment-${index}.txt`;

  return [
    `[Attachment ${index}]`,
    `Name: ${fileName}`,
    `MIME type: ${attachment.mimeType}`,
    "Content:",
    "----- BEGIN FILE -----",
    attachment.text,
    "----- END FILE -----"
  ].join("\n");
}

function formatBinaryAttachmentForPrompt(
  attachment: ConversationBinaryAttachment,
  storedPath: string,
  index: number
): string {
  const fileName = attachment.fileName?.trim() || `attachment-${index}.bin`;

  return [
    `[Attachment ${index}]`,
    `Name: ${fileName}`,
    `MIME type: ${attachment.mimeType}`,
    `Saved to: ${storedPath}`,
    "Use read/bash tools to inspect the file directly from disk."
  ].join("\n");
}

function sanitizeAttachmentFileName(fileName: string | undefined, fallback: string): string {
  const fallbackName = fallback.trim() || "attachment.bin";
  const trimmed = typeof fileName === "string" ? fileName.trim() : "";

  if (!trimmed) {
    return fallbackName;
  }

  const cleaned = trimmed
    .replace(/[\\/]+/g, "-")
    .replace(/[\0-\x1f\x7f]+/g, "")
    .replace(/\s+/g, " ")
    .replace(/^\.+/, "")
    .slice(0, 120);

  return cleaned || fallbackName;
}

function sanitizePathSegment(value: string, fallback: string): string {
  const cleaned = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);

  return cleaned || fallback;
}

function normalizeOptionalAttachmentPath(path: string | undefined): string | undefined {
  if (typeof path !== "string") {
    return undefined;
  }

  const trimmed = path.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function extractRuntimeMessageText(message: string | RuntimeUserMessage): string {
  if (typeof message === "string") {
    return message;
  }

  return message.text;
}

function formatInboundUserMessageForManager(text: string, sourceContext: MessageSourceContext): string {
  const sourceMetadataLine = `[sourceContext] ${JSON.stringify(sourceContext)}`;
  const trimmed = text.trim();

  if (trimmed.length === 0) {
    return sourceMetadataLine;
  }

  return `${sourceMetadataLine}\n\n${trimmed}`;
}

function formatTaskCompletionMessage(title: string): string {
  const normalizedTitle = title.trim();
  return `User completed task: ${normalizedTitle}. Check task comments for details.`;
}

function parseCompactSlashCommand(text: string): { customInstructions?: string } | undefined {
  const match = text.trim().match(/^\/compact(?:\s+([\s\S]+))?$/i);
  if (!match) {
    return undefined;
  }

  const customInstructions = match[1]?.trim();
  if (!customInstructions) {
    return {};
  }

  return {
    customInstructions
  };
}

function normalizeMessageTargetContext(input: MessageTargetContext): MessageTargetContext {
  return {
    channel:
      input.channel === "slack" || input.channel === "telegram"
        ? input.channel
        : "web",
    channelId: normalizeOptionalMetadataValue(input.channelId),
    userId: normalizeOptionalMetadataValue(input.userId),
    threadTs: normalizeOptionalMetadataValue(input.threadTs),
    integrationProfileId: normalizeOptionalMetadataValue(input.integrationProfileId)
  };
}

function normalizeMessageSourceContext(input: MessageSourceContext): MessageSourceContext {
  return {
    channel:
      input.channel === "slack" || input.channel === "telegram"
        ? input.channel
        : "web",
    channelId: normalizeOptionalMetadataValue(input.channelId),
    userId: normalizeOptionalMetadataValue(input.userId),
    messageId: normalizeOptionalMetadataValue(input.messageId),
    threadTs: normalizeOptionalMetadataValue(input.threadTs),
    integrationProfileId: normalizeOptionalMetadataValue(input.integrationProfileId),
    channelType:
      input.channelType === "dm" ||
      input.channelType === "channel" ||
      input.channelType === "group" ||
      input.channelType === "mpim"
        ? input.channelType
        : undefined,
    teamId: normalizeOptionalMetadataValue(input.teamId)
  };
}

function normalizeOptionalMetadataValue(value: string | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
