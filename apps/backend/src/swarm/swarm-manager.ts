import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";

import type {
  ContentPart,
  DeliveryMode as SwarmdDeliveryMode,
  EventEnvelope,
  HostCallRequest,
  SwarmdCoreHandle,
} from "swarmd";
import { createCore } from "swarmd";

import type { CreateScheduledTaskInput, ScheduledTask } from "../scheduler/schedule-types.js";
import {
  computeNextFireAt,
  normalizeOptionalScheduleText,
  normalizeScheduleText,
  normalizeScheduleTimezone,
  resolveScheduleName,
} from "../scheduler/schedule-utils.js";
import {
  loadArchetypePromptRegistry,
  type ArchetypePromptRegistry,
} from "./archetypes/archetype-prompt-registry.js";
import {
  listDirectories,
  normalizeAllowlistRoots,
  validateDirectory,
  type DirectoryListingResult,
  type DirectoryValidationResult,
} from "./cwd-policy.js";
import { pickDirectory as pickNativeDirectory } from "./directory-picker.js";
import {
  resolveCreateManagerModelPreset,
  DEFAULT_SWARM_MODEL_PRESET,
  inferSettingsAuthProviderFromDescriptor,
  inferSwarmModelPresetFromDescriptor,
  parseSwarmModelPreset,
  parseSwarmThinkingLevel,
  resolveModelDescriptorFromPreset,
} from "./model-presets.js";
import { SecretsEnvService } from "./secrets-env-service.js";
import { SkillMetadataService } from "./skill-metadata-service.js";
import { SwarmLifecycleService } from "./swarm-manager-lifecycle.js";
import {
  buildAttachmentMetadata,
  cloneDescriptor,
  type ConversationHistoryPageResult,
  extractEventText,
  fromSwarmdDeliveryMode,
  isAgentStatus,
  readBoolean,
  readObject,
  readRole,
  readString,
  safeJson,
  SwarmTranscriptService,
} from "./swarm-manager-transcript.js";
import { SwarmRuntimeContextService, MANAGER_ARCHETYPE_ID } from "./swarm-runtime-context.js";
import { buildSwarmTools, type SwarmToolHost } from "./swarm-tools.js";
import {
  MIDDLEMAN_STORE_MIGRATIONS,
  MiddlemanAgentRepo,
  MiddlemanManagerOrderRepo,
  MiddlemanScheduleRepo,
  MiddlemanSettingsRepo,
} from "./swarm-sql.js";
import type {
  AgentContextUsage,
  AgentDescriptor,
  AgentMessageEvent,
  AgentStatus,
  AgentToolCallEvent,
  AgentsSnapshotEvent,
  ConversationAttachment,
  ConversationEntryEvent,
  ConversationLogEvent,
  ConversationMessageEvent,
  MessageSourceContext,
  MessageTargetContext,
  RequestedDeliveryMode,
  SendMessageReceipt,
  SettingsAuthProvider,
  SkillEnvRequirement,
  SpawnAgentInput,
  SwarmConfig,
  SwarmModelPreset,
} from "./types.js";

const DEFAULT_REPLY_TARGET: MessageTargetContext = { channel: "web" };
const COMPACT_OPERATION_TIMEOUT_MS = 300_000;

function nowIso(): string {
  return new Date().toISOString();
}

function createEmptyArchetypePromptRegistry(): ArchetypePromptRegistry {
  return {
    resolvePrompt: () => undefined,
    listArchetypeIds: () => [],
  };
}

function normalizeContextUsage(value: unknown): AgentContextUsage | null | undefined {
  if (value === null) {
    return null;
  }

  const usage = readObject(value);
  const tokens = usage?.tokens;
  const contextWindow = usage?.contextWindow;
  const percent = usage?.percent;

  if (
    typeof tokens !== "number" ||
    !Number.isFinite(tokens) ||
    tokens < 0 ||
    typeof contextWindow !== "number" ||
    !Number.isFinite(contextWindow) ||
    contextWindow <= 0 ||
    typeof percent !== "number" ||
    !Number.isFinite(percent)
  ) {
    return undefined;
  }

  return {
    tokens: Math.round(tokens),
    contextWindow: Math.max(1, Math.round(contextWindow)),
    percent: Math.max(0, Math.min(100, percent)),
  };
}

export class SwarmManager extends EventEmitter implements SwarmToolHost {
  private readonly config: SwarmConfig;
  private readonly now: () => string;
  private readonly cwdAllowlistRoots: string[];

  private core: SwarmdCoreHandle | null = null;
  private agentRepo: MiddlemanAgentRepo | null = null;
  private managerOrderRepo: MiddlemanManagerOrderRepo | null = null;
  private scheduleRepo: MiddlemanScheduleRepo | null = null;
  private settingsRepo: MiddlemanSettingsRepo | null = null;
  private readonly skillMetadataService: SkillMetadataService;
  private secretsEnvService: SecretsEnvService | null = null;
  private archetypePromptRegistry: ArchetypePromptRegistry = createEmptyArchetypePromptRegistry();
  private unsubscribeCoreEvents: (() => void) | null = null;
  private readonly lastWorkerCompletionReportTimestampByAgentId = new Map<string, string>();
  private readonly pendingWorkerCompletionReportAgentIds = new Set<string>();
  private readonly suppressNextWorkerCompletionReportAgentIds = new Set<string>();
  private readonly compactingAgentIds = new Set<string>();

  private readonly runtimeContext: SwarmRuntimeContextService;
  private readonly lifecycle: SwarmLifecycleService;
  private readonly transcript: SwarmTranscriptService;

  constructor(config: SwarmConfig, options?: { now?: () => string }) {
    super();

    const defaultPreset =
      inferSwarmModelPresetFromDescriptor(config.defaultModel) ?? DEFAULT_SWARM_MODEL_PRESET;
    this.cwdAllowlistRoots = normalizeAllowlistRoots(config.cwdAllowlistRoots);
    this.config = {
      ...config,
      defaultModel: resolveModelDescriptorFromPreset(defaultPreset),
      cwdAllowlistRoots: this.cwdAllowlistRoots,
    };
    this.now = options?.now ?? nowIso;
    this.skillMetadataService = new SkillMetadataService({
      config: this.config,
    });

    this.runtimeContext = new SwarmRuntimeContextService({
      config: this.config,
      cwdAllowlistRoots: this.cwdAllowlistRoots,
      skillMetadataService: this.skillMetadataService,
      getArchetypePromptRegistry: () => this.archetypePromptRegistry,
      getSettingsRepo: () => this.settingsRepoOrThrow(),
      listAgents: () => this.lifecycle.getSortedDescriptors(),
    });
    this.lifecycle = new SwarmLifecycleService({
      config: this.config,
      now: this.now,
      runtimeContext: this.runtimeContext,
      getCore: () => this.coreOrThrow(),
      getAgentRepo: () => this.agentRepoOrThrow(),
      getManagerOrderRepo: () => this.managerOrderRepoOrThrow(),
    });
    this.transcript = new SwarmTranscriptService({
      getCore: () => this.coreOrThrow(),
      getAgent: (agentId) => this.lifecycle.getAgent(agentId),
      resolvePreferredManagerId: () => this.lifecycle.resolvePreferredManagerId(),
      resolveRuntimeErrorMessage: (descriptor, payload) =>
        this.resolveRuntimeErrorMessage(descriptor, payload),
    });
  }

  async boot(): Promise<void> {
    await this.runtimeContext.ensureDirectories();

    this.core = await createCore(
      {
        dataDir: this.config.paths.dataDir,
        dbPath: this.config.paths.swarmdDbFile,
      },
      {
        migrations: MIDDLEMAN_STORE_MIGRATIONS,
        onHostCall: async (sessionId, request) => await this.handleHostCall(sessionId, request),
        runRecovery: false,
      },
    );

    const db = this.core.db;
    this.agentRepo = new MiddlemanAgentRepo(db);
    this.managerOrderRepo = new MiddlemanManagerOrderRepo(db);
    this.scheduleRepo = new MiddlemanScheduleRepo(db);
    this.settingsRepo = new MiddlemanSettingsRepo(db);
    this.secretsEnvService = new SecretsEnvService({
      config: this.config,
      settingsRepo: this.settingsRepo,
      ensureSkillMetadataLoaded: () => this.skillMetadataService.ensureSkillMetadataLoaded(),
      getSkillMetadata: () => this.skillMetadataService.getSkillMetadata(),
    });

    await this.secretsEnvService.loadSecretsStore();
    await this.skillMetadataService.ensureSkillMetadataLoaded();
    this.archetypePromptRegistry = await loadArchetypePromptRegistry({
      builtInDir: this.config.paths.installArchetypesDir,
      projectOverridesDir: this.config.paths.projectArchetypesDir,
    });

    this.core.sessionService.reconcilePersistedSessions();
    this.suppressExpectedShutdownErrors();
    await this.runtimeContext.ensureMemoryFilesForAgents();
    await this.lifecycle.ensureManagerOrder();
    this.installCoreEventProjection();
  }

  async shutdown(): Promise<void> {
    this.unsubscribeCoreEvents?.();
    this.unsubscribeCoreEvents = null;

    if (this.core) {
      await this.core.shutdown();
    }

    this.core = null;
    this.agentRepo = null;
    this.managerOrderRepo = null;
    this.scheduleRepo = null;
    this.settingsRepo = null;
    this.secretsEnvService = null;
    this.lastWorkerCompletionReportTimestampByAgentId.clear();
    this.pendingWorkerCompletionReportAgentIds.clear();
  }

  getConfig(): SwarmConfig {
    return this.config;
  }

  getAgent(agentId: string): AgentDescriptor | undefined {
    return this.lifecycle.getAgent(agentId);
  }

  listAgents(options?: { includeArchived?: boolean }): AgentDescriptor[] {
    return this.lifecycle.getSortedDescriptors(options).map(cloneDescriptor);
  }

  getConversationHistory(agentId?: string, options?: { limit?: number }): ConversationEntryEvent[] {
    return this.transcript.projectConversationEntries(agentId, options?.limit);
  }

  getConversationHistoryPage(
    agentId: string | undefined,
    options: { before?: string; limit: number },
  ): ConversationHistoryPageResult {
    return this.transcript.getConversationHistoryPage(agentId, options);
  }

  getVisibleTranscript(
    agentId?: string,
    options?: { limit?: number },
  ): Array<ConversationMessageEvent | ConversationLogEvent | AgentMessageEvent> {
    return this.transcript.getVisibleTranscript(agentId, options);
  }

  getVisibleTranscriptPage(
    agentId: string | undefined,
    options: { before?: string; limit?: number },
  ): ConversationHistoryPageResult<
    ConversationMessageEvent | ConversationLogEvent | AgentMessageEvent
  > {
    return this.transcript.getVisibleTranscriptPage(agentId, options);
  }

  async createManager(
    callerAgentId: string,
    input: { name: string; cwd: string; model?: SwarmModelPreset },
  ): Promise<AgentDescriptor> {
    const caller = this.getAgent(callerAgentId);
    if (caller && caller.role !== "manager") {
      throw new Error("Only managers can create managers.");
    }
    if (!caller && this.lifecycle.listManagers().length > 0) {
      throw new Error("Only managers can create managers.");
    }

    const managerId = this.lifecycle.generateUniqueManagerId(input.name);
    const cwd = await this.runtimeContext.resolveAndValidateCwd(input.cwd);
    const model = resolveModelDescriptorFromPreset(
      resolveCreateManagerModelPreset(input.model, "create_manager.model"),
    );
    const descriptor = await this.lifecycle.createAgentSessionAndRow({
      agentId: managerId,
      role: "manager",
      managerId,
      archetypeId: MANAGER_ARCHETYPE_ID,
      cwd,
      model,
      memoryOwnerAgentId: managerId,
    });

    this.managerOrderRepoOrThrow().ensure([descriptor.agentId]);
    this.emitStatus(descriptor.agentId, descriptor.status, 0);
    this.emitAgentsSnapshot();
    await this.lifecycle.sendManagerBootstrapMessage(managerId, async (from, to, message) => {
      await this.sendMessage(from, to, message, "auto");
    });
    return cloneDescriptor(descriptor);
  }

  async spawnAgent(callerAgentId: string, input: SpawnAgentInput): Promise<AgentDescriptor> {
    const manager = this.lifecycle.assertManager(callerAgentId, "spawn agents");
    const requestedAgentId = input.agentId?.trim();
    if (!requestedAgentId) {
      throw new Error("spawn_agent requires a non-empty agentId");
    }

    const agentId = this.lifecycle.generateUniqueAgentId(requestedAgentId);
    const cwd = input.cwd
      ? await this.runtimeContext.resolveAndValidateCwd(input.cwd)
      : manager.cwd;
    const thinkingLevel = parseSwarmThinkingLevel(input.thinkingLevel, "spawn_agent.thinkingLevel");
    const modelPreset = parseSwarmModelPreset(input.model, "spawn_agent.model");
    const model = modelPreset
      ? resolveModelDescriptorFromPreset(modelPreset, thinkingLevel)
      : thinkingLevel
        ? {
            ...manager.model,
            thinkingLevel,
          }
        : manager.model;
    const archetypeId = this.lifecycle.resolveSpawnWorkerArchetypeId(input.archetypeId);
    const descriptor = await this.lifecycle.createAgentSessionAndRow({
      agentId,
      role: "worker",
      managerId: manager.agentId,
      archetypeId,
      cwd,
      model,
      memoryOwnerAgentId: manager.agentId,
      systemPrompt: input.systemPrompt?.trim() || undefined,
    });

    this.emitStatus(descriptor.agentId, descriptor.status, 0);
    this.emitAgentsSnapshot();

    if (input.initialMessage?.trim()) {
      await this.sendMessage(manager.agentId, descriptor.agentId, input.initialMessage, "auto");
    }

    return cloneDescriptor(descriptor);
  }

  async killAgent(callerAgentId: string, targetAgentId: string): Promise<void> {
    const manager = this.lifecycle.assertManager(callerAgentId, "kill agents");
    const target = this.lifecycle.requireDescriptor(targetAgentId);

    if (target.role !== "worker") {
      throw new Error("Only worker agents can be killed.");
    }
    if (target.managerId !== manager.agentId) {
      throw new Error(`Only the owning manager can kill ${targetAgentId}.`);
    }

    await this.lifecycle.terminateSession(target.agentId);
    this.coreOrThrow().archiveSession(target.agentId);
    this.clearWorkerCompletionReportTracking(target.agentId);
    this.emitStatus(target.agentId, "terminated", 0);
    this.emitAgentsSnapshot();
  }

  async interruptAgentForUser(
    callerAgentId: string,
    targetAgentId: string,
  ): Promise<{ agentId: string; interrupted: boolean }> {
    const manager = this.lifecycle.assertManager(callerAgentId, "interrupt agents");
    const target = this.lifecycle.requireDescriptor(targetAgentId);

    if (target.role === "manager") {
      if (target.agentId !== manager.agentId) {
        throw new Error(`Only ${target.agentId} can interrupt itself.`);
      }
    } else if (target.managerId !== manager.agentId) {
      throw new Error(`Only the owning manager can interrupt ${targetAgentId}.`);
    }

    const interrupted = await this.interruptSessionIfActive(target.agentId);
    if (interrupted && target.role === "worker") {
      this.suppressNextWorkerCompletionReportAgentIds.add(target.agentId);
    }

    return {
      agentId: target.agentId,
      interrupted,
    };
  }

  async compactAgentForUser(
    callerAgentId: string,
    targetAgentId: string,
  ): Promise<{ agentId: string; compacted: true }> {
    const manager = this.lifecycle.assertManager(callerAgentId, "compact agents");
    const target = this.lifecycle.requireDescriptor(targetAgentId);

    if (target.role === "manager") {
      if (target.agentId !== manager.agentId) {
        throw new Error(`Only ${target.agentId} can compact itself.`);
      }
    } else if (target.managerId !== manager.agentId) {
      throw new Error(`Only the owning manager can compact ${targetAgentId}.`);
    }

    const core = this.coreOrThrow();
    const session = core.sessionService.getById(target.agentId);
    if (!session || !core.supervisor.hasWorker(target.agentId)) {
      throw new Error(`Agent ${target.agentId} does not have a running Pi session.`);
    }

    if (session.backend !== "pi") {
      throw new Error(`Agent ${target.agentId} is not using the Pi backend.`);
    }

    if (this.isAgentCompacting(target.agentId)) {
      throw new Error(`Manual compaction is already in progress for ${target.agentId}.`);
    }

    if (session.status !== "idle") {
      throw new Error(
        `Agent ${target.agentId} is busy. Wait for the current turn to finish or interrupt it before compacting.`,
      );
    }

    this.compactingAgentIds.add(target.agentId);

    try {
      const operationId = core.messageService.compact(target.agentId);
      await this.waitForOperationCompletion(target.agentId, operationId);
      return {
        agentId: target.agentId,
        compacted: true,
      };
    } finally {
      this.compactingAgentIds.delete(target.agentId);
    }
  }

  async stopAllAgents(
    callerAgentId: string,
    targetManagerId: string,
  ): Promise<{
    managerId: string;
    stoppedWorkerIds: string[];
    managerStopped: boolean;
  }> {
    const manager = this.lifecycle.assertManager(callerAgentId, "stop all agents");
    if (manager.agentId !== targetManagerId) {
      throw new Error(`Only ${targetManagerId} can stop its team.`);
    }

    const workerIds = this.listAgents()
      .filter((agent) => agent.role === "worker" && agent.managerId === targetManagerId)
      .map((agent) => agent.agentId);
    const stoppedWorkerIds: string[] = [];

    for (const workerId of workerIds) {
      if (await this.interruptSessionIfActive(workerId)) {
        this.suppressNextWorkerCompletionReportAgentIds.add(workerId);
        stoppedWorkerIds.push(workerId);
      }
    }

    const managerStopped = await this.interruptSessionIfActive(targetManagerId);

    return {
      managerId: targetManagerId,
      stoppedWorkerIds,
      managerStopped,
    };
  }

  async deleteManager(
    callerAgentId: string,
    targetManagerId: string,
  ): Promise<{ managerId: string; terminatedWorkerIds: string[] }> {
    this.lifecycle.assertManager(callerAgentId, "delete managers");
    const target = this.lifecycle.requireDescriptor(targetManagerId);
    if (target.role !== "manager") {
      throw new Error(`Unknown manager: ${targetManagerId}`);
    }

    const workerIds = this.listAgents({ includeArchived: true })
      .filter((agent) => agent.role === "worker" && agent.managerId === targetManagerId)
      .map((agent) => agent.agentId);

    for (const workerId of workerIds) {
      this.clearWorkerCompletionReportTracking(workerId);
      await this.lifecycle.deleteAgentSession(workerId);
    }

    await this.lifecycle.deleteAgentSession(targetManagerId);
    this.managerOrderRepoOrThrow().remove(targetManagerId);

    this.emitAgentsSnapshot();

    return {
      managerId: targetManagerId,
      terminatedWorkerIds: workerIds,
    };
  }

  async reorderManagers(callerAgentId: string, managerIds: string[]): Promise<string[]> {
    this.lifecycle.assertManager(callerAgentId, "reorder managers");
    const actualManagerIds = new Set(
      this.lifecycle.listManagers().map((manager) => manager.agentId),
    );
    const normalized = managerIds.map((managerId) => managerId.trim()).filter(Boolean);

    if (normalized.length !== actualManagerIds.size) {
      throw new Error("reorder_managers must include every manager exactly once");
    }

    for (const managerId of normalized) {
      if (!actualManagerIds.has(managerId)) {
        throw new Error(`Unknown manager in reorder_managers: ${managerId}`);
      }
    }

    const ordered = this.managerOrderRepoOrThrow().reorder(normalized);
    this.emitAgentsSnapshot();
    return ordered;
  }

  async handleUserMessage(
    text: string,
    options?: {
      targetAgentId?: string;
      delivery?: RequestedDeliveryMode;
      attachments?: ConversationAttachment[];
      sourceContext?: MessageSourceContext;
    },
  ): Promise<void> {
    const targetAgentId = options?.targetAgentId ?? this.lifecycle.resolvePreferredManagerId();
    if (!targetAgentId) {
      throw new Error("No target agent is available.");
    }

    const target = this.lifecycle.requireDescriptor(targetAgentId);
    const attachments = options?.attachments ?? [];
    await this.ensureAgentReadyForInput(target);

    const metadata = {
      middleman: {
        version: 1,
        agentId: target.agentId,
        managerId: target.managerId,
        renderAs: "conversation_message",
        source: "user_input",
        sourceContext: options?.sourceContext,
        attachments: buildAttachmentMetadata(attachments),
      },
    };

    this.coreOrThrow().messageService.send(target.agentId, toContentParts(text, attachments), {
      delivery: toSwarmdDeliveryMode(options?.delivery),
      role: "user",
      metadata,
    });

    this.emitConversationMessage({
      type: "conversation_message",
      agentId: target.agentId,
      role: "user",
      text,
      attachments: buildAttachmentMetadata(attachments),
      timestamp: this.now(),
      source: "user_input",
      sourceContext: options?.sourceContext,
    });
  }

  async sendMessage(
    fromAgentId: string,
    targetAgentId: string,
    message: string,
    delivery: RequestedDeliveryMode = "auto",
  ): Promise<SendMessageReceipt> {
    const sender = this.lifecycle.requireDescriptor(fromAgentId);
    const target = await this.ensureAgentReadyForInput(targetAgentId);

    const receipt = this.coreOrThrow().messageService.send(
      target.agentId,
      toContentParts(message, []),
      {
        delivery: toSwarmdDeliveryMode(delivery),
        role: "system",
        metadata: {
          middleman: {
            version: 1,
            agentId: target.agentId,
            managerId: target.managerId,
            visibility: "internal",
            renderAs: "hidden",
            source: "system",
            routing: {
              fromAgentId: sender.agentId,
              toAgentId: target.agentId,
              origin: "agent",
              requestedDelivery: delivery,
            },
          },
        },
      },
    );

    const agentMessageEvent: AgentMessageEvent = {
      type: "agent_message",
      agentId: target.role === "manager" ? target.agentId : target.managerId,
      timestamp: this.now(),
      source: "agent_to_agent",
      fromAgentId: sender.agentId,
      toAgentId: target.agentId,
      text: message,
      requestedDelivery: delivery,
      acceptedMode: fromSwarmdDeliveryMode(receipt.acceptedDelivery, delivery),
    };

    this.emitAgentMessage(agentMessageEvent);

    if (target.agentId !== agentMessageEvent.agentId) {
      this.emitAgentMessage({
        ...agentMessageEvent,
        agentId: target.agentId,
      });
    }

    if (
      sender.role === "manager" &&
      target.role === "manager" &&
      sender.agentId !== target.agentId
    ) {
      this.emitAgentMessage({
        ...agentMessageEvent,
        agentId: sender.agentId,
      });
    }

    return {
      targetAgentId: target.agentId,
      deliveryId: receipt.operationId,
      acceptedMode: fromSwarmdDeliveryMode(receipt.acceptedDelivery, delivery),
    };
  }

  async publishToUser(
    agentId: string,
    text: string,
    source: "speak_to_user" | "system" = "speak_to_user",
    targetContext?: MessageTargetContext,
  ): Promise<{ targetContext: MessageSourceContext }> {
    const descriptor = this.lifecycle.assertManager(agentId, "speak to user");
    const resolvedTarget = targetContext ?? DEFAULT_REPLY_TARGET;
    if (targetContext) {
      this.agentRepoOrThrow().updateReplyTarget(agentId, targetContext);
    }

    const sourceContext: MessageSourceContext = {
      ...resolvedTarget,
      channel: resolvedTarget.channel,
    };

    this.emitConversationMessage({
      type: "conversation_message",
      agentId: descriptor.agentId,
      role: source === "system" ? "system" : "assistant",
      text,
      timestamp: this.now(),
      source,
      sourceContext,
    });

    return { targetContext: sourceContext };
  }

  async resetManagerSession(
    managerId: string,
    reason: "user_new_command" | "api_reset" = "api_reset",
  ): Promise<void> {
    const descriptor = this.lifecycle.requireDescriptor(managerId);
    if (descriptor.role !== "manager") {
      throw new Error("Only manager sessions can be reset.");
    }

    const existingRow = this.agentRepoOrThrow().get(managerId);
    if (!existingRow) {
      throw new Error(`Unknown manager: ${managerId}`);
    }

    const basePrompt = this.runtimeContext.resolveSystemPromptForDescriptor({
      role: "manager",
      archetypeId: existingRow.archetypeId ?? MANAGER_ARCHETYPE_ID,
    });
    const resources = await this.runtimeContext.resolveRuntimeContextResources({
      agentId: managerId,
      role: "manager",
      managerId,
      cwd: descriptor.cwd,
      model: descriptor.model,
      memoryOwnerAgentId: existingRow.memoryOwnerSessionId,
    });
    const runtimeConfig = this.runtimeContext.buildRuntimeConfig(
      {
        agentId: managerId,
        role: "manager",
        managerId,
        cwd: descriptor.cwd,
        model: descriptor.model,
        memoryOwnerAgentId: existingRow.memoryOwnerSessionId,
      },
      resources,
    );
    const systemPrompt = this.runtimeContext.buildSessionSystemPrompt(
      basePrompt,
      runtimeConfig.backend,
      resources,
    );

    await this.lifecycle.stopSession(managerId);
    this.coreOrThrow().sessionService.reset(managerId, {
      systemPrompt,
      runtimeConfig: {
        backendConfig: runtimeConfig.backendConfig,
      },
      updatedAt: this.now(),
    });
    await this.coreOrThrow().sessionService.start(managerId);

    const recreated = this.lifecycle.requireDescriptor(managerId);

    this.emit("conversation_reset", {
      type: "conversation_reset",
      agentId: recreated.agentId,
      timestamp: this.now(),
      reason,
    } satisfies {
      type: "conversation_reset";
      agentId: string;
      timestamp: string;
      reason: "user_new_command" | "api_reset";
    });
    this.emitStatus(recreated.agentId, recreated.status, 0);
  }

  async listSchedulesForManager(managerId: string): Promise<ScheduledTask[]> {
    this.lifecycle.assertManager(managerId, "list schedules");
    return this.scheduleRepoOrThrow().listForManager(managerId);
  }

  async createScheduleForManager(
    managerId: string,
    input: CreateScheduledTaskInput,
  ): Promise<ScheduledTask> {
    this.lifecycle.assertManager(managerId, "manage schedules");
    const cron = normalizeScheduleText(input.cron, "Schedule cron");
    const message = normalizeScheduleText(input.message, "Schedule message");
    const timezone = normalizeScheduleTimezone(input.timezone);
    const now = this.now();
    const createdAt = now;
    const schedule: ScheduledTask = {
      id: randomUUID(),
      managerId,
      name: resolveScheduleName({
        name: input.name,
        description: input.description,
        message,
      }),
      description: normalizeOptionalScheduleText(input.description),
      cron,
      message,
      enabled: input.enabled ?? true,
      oneShot: input.oneShot ?? false,
      timezone,
      createdAt,
      updatedAt: createdAt,
      nextFireAt: computeNextFireAt(cron, timezone, new Date(createdAt)),
    };

    const created = this.scheduleRepoOrThrow().create(schedule);
    this.emit("schedule_changed", { managerId });
    return created;
  }

  async updateScheduleForManager(
    managerId: string,
    schedule: ScheduledTask,
  ): Promise<ScheduledTask> {
    this.lifecycle.assertManager(managerId, "manage schedules");
    if (schedule.managerId !== managerId) {
      throw new Error(`Schedule ${schedule.id} does not belong to manager ${managerId}.`);
    }

    return this.scheduleRepoOrThrow().update(schedule);
  }

  async removeScheduleForManager(managerId: string, scheduleId: string): Promise<ScheduledTask> {
    this.lifecycle.assertManager(managerId, "manage schedules");
    const removed = this.scheduleRepoOrThrow().remove(managerId, scheduleId);
    this.emit("schedule_changed", { managerId });
    return removed;
  }

  async listSettingsEnv(): Promise<SkillEnvRequirement[]> {
    return await this.secretsEnvServiceOrThrow().listSettingsEnv();
  }

  async updateSettingsEnv(values: Record<string, string>): Promise<void> {
    await this.secretsEnvServiceOrThrow().updateSettingsEnv(values);
  }

  async deleteSettingsEnv(name: string): Promise<void> {
    await this.secretsEnvServiceOrThrow().deleteSettingsEnv(name);
  }

  async listSettingsAuth(): Promise<SettingsAuthProvider[]> {
    return await this.secretsEnvServiceOrThrow().listSettingsAuth();
  }

  async updateSettingsAuth(values: Record<string, string>): Promise<void> {
    await this.secretsEnvServiceOrThrow().updateSettingsAuth(values);
  }

  async deleteSettingsAuth(provider: string): Promise<void> {
    await this.secretsEnvServiceOrThrow().deleteSettingsAuth(provider);
  }

  async listDirectories(path?: string): Promise<DirectoryListingResult> {
    return await listDirectories(path, {
      rootDir: this.config.defaultCwd,
      allowlistRoots: this.cwdAllowlistRoots,
    });
  }

  async validateDirectory(path: string): Promise<DirectoryValidationResult> {
    return await validateDirectory(path, {
      rootDir: this.config.defaultCwd,
      allowlistRoots: this.cwdAllowlistRoots,
    });
  }

  async pickDirectory(defaultPath?: string): Promise<string | null> {
    return await pickNativeDirectory(defaultPath ? { defaultPath } : undefined);
  }

  private installCoreEventProjection(): void {
    if (this.unsubscribeCoreEvents) {
      return;
    }

    this.unsubscribeCoreEvents = this.coreOrThrow().eventBus.subscribe((event) => {
      this.handleCoreEvent(event);
    });
  }

  private handleCoreEvent(event: EventEnvelope): void {
    const descriptor = this.getAgent(event.sessionId);
    if (!descriptor) {
      return;
    }

    if (event.type === "session.status.changed") {
      const status = readString(readObject(event.payload)?.status);
      const contextUsage = normalizeContextUsage(readObject(event.payload)?.contextUsage);
      if (isAgentStatus(status)) {
        // Live status/context usage changes do not require rebuilding the full
        // agent snapshot for every subscribed client.
        this.emitStatus(descriptor.agentId, status, 0, contextUsage);
        if (descriptor.role === "worker") {
          if (status === "idle") {
            void this.maybeEmitWorkerCompletionSummary(descriptor.agentId);
          } else if (
            (status === "starting" || status === "busy") &&
            this.suppressNextWorkerCompletionReportAgentIds.has(descriptor.agentId)
          ) {
            this.suppressNextWorkerCompletionReportAgentIds.delete(descriptor.agentId);
          }
        }
      }
      return;
    }

    switch (event.type) {
      case "session.errored": {
        if (descriptor.role === "worker") {
          this.pendingWorkerCompletionReportAgentIds.delete(descriptor.agentId);
          this.suppressNextWorkerCompletionReportAgentIds.delete(descriptor.agentId);
        }
        const runtimeErrorMessage = this.resolveRuntimeErrorMessage(descriptor, event.payload);
        const runtimeErrorEvent: ConversationLogEvent = {
          type: "conversation_log",
          agentId: descriptor.agentId,
          timestamp: event.timestamp,
          source: "runtime_log",
          kind: "message_end",
          text: runtimeErrorMessage,
          isError: true,
        };
        this.persistConversationLog(runtimeErrorEvent);
        this.emitConversationLog(runtimeErrorEvent);
        if (descriptor.role === "worker") {
          void this.maybeEmitWorkerErrorReport(descriptor.agentId, runtimeErrorMessage);
        }
        return;
      }
      case "message.started": {
        const messageStartedEvent: ConversationLogEvent = {
          type: "conversation_log",
          agentId: descriptor.agentId,
          timestamp: event.timestamp,
          source: "runtime_log",
          kind: "message_start",
          role: readRole(readObject(event.payload)?.role),
          text: extractEventText(event.payload) ?? "",
        };
        this.persistConversationLog(messageStartedEvent);
        this.emitConversationLog(messageStartedEvent);
        return;
      }
      case "message.completed": {
        const role = this.resolveCompletedMessageRole(descriptor.agentId, event.payload);
        const messageCompletedEvent: ConversationLogEvent = {
          type: "conversation_log",
          agentId: descriptor.agentId,
          timestamp: event.timestamp,
          source: "runtime_log",
          kind: "message_end",
          role,
          text: extractEventText(event.payload) ?? "",
        };
        this.persistConversationLog(messageCompletedEvent);
        this.emitConversationLog(messageCompletedEvent);
        if (descriptor.role === "worker" && (role === "assistant" || role === "system")) {
          this.pendingWorkerCompletionReportAgentIds.add(descriptor.agentId);
          void this.maybeEmitWorkerCompletionSummary(descriptor.agentId);
        }
        return;
      }
      case "tool.started": {
        const toolStartedEvent: AgentToolCallEvent = {
          type: "agent_tool_call",
          agentId: descriptor.agentId,
          actorAgentId: descriptor.agentId,
          timestamp: event.timestamp,
          kind: "tool_execution_start",
          toolName: readString(readObject(event.payload)?.toolName),
          toolCallId: readString(readObject(event.payload)?.toolCallId),
          text: safeJson(readObject(event.payload)?.input),
        };
        this.persistAgentToolCall(toolStartedEvent);
        this.emitAgentToolCall(toolStartedEvent);
        return;
      }
      case "tool.progress": {
        const toolProgressEvent: AgentToolCallEvent = {
          type: "agent_tool_call",
          agentId: descriptor.agentId,
          actorAgentId: descriptor.agentId,
          timestamp: event.timestamp,
          kind: "tool_execution_update",
          toolName: readString(readObject(event.payload)?.toolName),
          toolCallId: readString(readObject(event.payload)?.toolCallId),
          text: safeJson(readObject(event.payload)?.progress),
        };
        this.persistAgentToolCall(toolProgressEvent);
        this.emitAgentToolCall(toolProgressEvent);
        return;
      }
      case "tool.completed": {
        const toolCompletedEvent: AgentToolCallEvent = {
          type: "agent_tool_call",
          agentId: descriptor.agentId,
          actorAgentId: descriptor.agentId,
          timestamp: event.timestamp,
          kind: "tool_execution_end",
          toolName: readString(readObject(event.payload)?.toolName),
          toolCallId: readString(readObject(event.payload)?.toolCallId),
          text: safeJson(readObject(event.payload)?.result),
          isError: readObject(event.payload)?.ok === false,
        };
        this.persistAgentToolCall(toolCompletedEvent);
        this.emitAgentToolCall(toolCompletedEvent);
        return;
      }
      default:
        return;
    }
  }

  private resolveRuntimeErrorMessage(descriptor: AgentDescriptor, payload: unknown): string {
    const configuredAuthProvider = inferSettingsAuthProviderFromDescriptor(descriptor.model);
    const isMissingConfiguredAuth =
      configuredAuthProvider &&
      this.secretsEnvService &&
      !this.secretsEnvService.hasSettingsAuth(configuredAuthProvider);
    if (isMissingConfiguredAuth) {
      return `Missing authentication for ${configuredAuthProvider}. Configure credentials in Settings.`;
    }

    const payloadObject = readObject(payload);
    const errorObject = readObject(payloadObject?.error);
    const message =
      readString(errorObject?.message)?.trim() ?? readString(payloadObject?.message)?.trim() ?? "";

    if (message.length > 0) {
      return message;
    }

    return "Agent runtime failed.";
  }

  private async handleHostCall(sessionId: string, request: HostCallRequest): Promise<unknown> {
    if (request.method !== "tool_call") {
      throw new Error(`Unsupported host call method: ${request.method}`);
    }

    const descriptor = this.lifecycle.requireDescriptor(sessionId);
    const tool = buildSwarmTools(this, descriptor, {
      availableArchetypeIds: this.archetypePromptRegistry.listArchetypeIds(),
    }).find((definition) => definition.name === request.payload.toolName);
    if (!tool) {
      throw new Error(`Unknown tool: ${request.payload.toolName}`);
    }

    return await tool.execute(request.requestId, request.payload.args);
  }

  private async ensureAgentReadyForInput(
    agent: string | AgentDescriptor,
  ): Promise<AgentDescriptor> {
    const descriptor = typeof agent === "string" ? this.lifecycle.requireDescriptor(agent) : agent;
    const core = this.coreOrThrow();

    if (descriptor.status === "terminated") {
      if (descriptor.role === "manager") {
        const session = core.sessionService.getById(descriptor.agentId);
        if (!session) {
          throw new Error(
            `Agent ${descriptor.agentId} has been terminated and cannot be restored.`,
          );
        }

        core.sessionService.applyRuntimeStatus(
          descriptor.agentId,
          "stopped",
          null,
          session.contextUsage,
        );
        await core.sessionService.start(descriptor.agentId);
        return this.lifecycle.requireDescriptor(descriptor.agentId);
      }

      throw new Error(
        `Agent ${descriptor.agentId} has been terminated and cannot receive messages.`,
      );
    }

    if (descriptor.status === "stopping") {
      throw new Error(
        `Agent ${descriptor.agentId} is stopping. Wait for it to stop before sending another message.`,
      );
    }

    if (this.isAgentCompacting(descriptor.agentId)) {
      throw new Error(
        `Agent ${descriptor.agentId} is compacting. Wait for compaction to finish before sending another message.`,
      );
    }

    if (descriptor.status === "errored") {
      await core.sessionService.stop(descriptor.agentId);
      await core.sessionService.start(descriptor.agentId);
      return this.lifecycle.requireDescriptor(descriptor.agentId);
    }

    if (descriptor.status === "created" || descriptor.status === "stopped") {
      await core.sessionService.start(descriptor.agentId);
      return this.lifecycle.requireDescriptor(descriptor.agentId);
    }

    return descriptor;
  }

  private resolveCompletedMessageRole(
    agentId: string,
    payload: unknown,
  ): "assistant" | "system" | "user" | undefined {
    const payloadObject = readObject(payload);
    const role = readRole(payloadObject?.role);
    if (role) {
      return role;
    }

    const sourceMessageId = readString(payloadObject?.messageId);
    if (!sourceMessageId) {
      return undefined;
    }

    // Codex and Claude completed-message events omit role; recover it from the
    // stored message captured earlier in the same event dispatch.
    return readRole(
      this.coreOrThrow().messageStore.getLatestBySourceMessageId(agentId, sourceMessageId)?.role,
    );
  }

  private persistConversationLog(event: ConversationLogEvent): void {
    this.coreOrThrow().messageStore.append(event.agentId, {
      source: "system",
      kind: "middleman_event",
      role: "system",
      content: {
        text: event.text,
      },
      createdAt: event.timestamp,
      metadata: {
        middleman: {
          version: 1,
          renderAs: "conversation_log",
          event,
        },
      },
    });
  }

  private persistAgentToolCall(event: AgentToolCallEvent): void {
    const persistedEvent: Omit<AgentToolCallEvent, "text"> = {
      type: event.type,
      agentId: event.agentId,
      actorAgentId: event.actorAgentId,
      timestamp: event.timestamp,
      kind: event.kind,
      ...(event.toolName === undefined ? {} : { toolName: event.toolName }),
      ...(event.toolCallId === undefined ? {} : { toolCallId: event.toolCallId }),
      ...(event.isError === undefined ? {} : { isError: event.isError }),
    };

    this.coreOrThrow().messageStore.append(event.actorAgentId, {
      source: "system",
      kind: "middleman_event",
      role: "system",
      content: {
        text: event.text,
      },
      createdAt: event.timestamp,
      metadata: {
        middleman: {
          version: 1,
          renderAs: "agent_tool_call",
          event: persistedEvent,
        },
      },
    });
  }

  private async maybeEmitWorkerCompletionSummary(agentId: string): Promise<void> {
    if (!this.pendingWorkerCompletionReportAgentIds.has(agentId)) {
      return;
    }

    const session = this.coreOrThrow().sessionService.getById(agentId);
    if (!session || session.status !== "idle") {
      return;
    }

    const descriptor = this.lifecycle.getAgent(agentId);
    if (!descriptor || descriptor.role !== "worker") {
      this.pendingWorkerCompletionReportAgentIds.delete(agentId);
      return;
    }

    const manager = this.lifecycle.getAgent(descriptor.managerId);
    if (!manager || manager.role !== "manager") {
      this.pendingWorkerCompletionReportAgentIds.delete(agentId);
      return;
    }

    if (this.suppressNextWorkerCompletionReportAgentIds.has(agentId)) {
      this.pendingWorkerCompletionReportAgentIds.delete(agentId);
      this.suppressNextWorkerCompletionReportAgentIds.delete(agentId);
      return;
    }

    const report = buildWorkerCompletionReport(
      descriptor,
      this.getConversationHistory(agentId),
      this.lastWorkerCompletionReportTimestampByAgentId.get(agentId),
    );

    this.pendingWorkerCompletionReportAgentIds.delete(agentId);

    try {
      await this.sendMessage(agentId, manager.agentId, report.message, "auto");
      if (report.summaryTimestamp) {
        this.lastWorkerCompletionReportTimestampByAgentId.set(agentId, report.summaryTimestamp);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[swarm] Failed to send worker completion summary for ${agentId}: ${message}`);
    }
  }

  private async maybeEmitWorkerErrorReport(agentId: string, errorMessage: string): Promise<void> {
    const descriptor = this.lifecycle.getAgent(agentId);
    if (!descriptor || descriptor.role !== "worker") {
      return;
    }

    const manager = this.lifecycle.getAgent(descriptor.managerId);
    if (!manager || manager.role !== "manager") {
      return;
    }

    try {
      await this.sendMessage(
        agentId,
        manager.agentId,
        `SYSTEM: Worker ${agentId} errored: ${errorMessage}`,
        "auto",
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[swarm] Failed to send worker error report for ${agentId}: ${message}`);
    }
  }

  private clearWorkerCompletionReportTracking(agentId: string): void {
    this.pendingWorkerCompletionReportAgentIds.delete(agentId);
    this.lastWorkerCompletionReportTimestampByAgentId.delete(agentId);
    this.suppressNextWorkerCompletionReportAgentIds.delete(agentId);
  }

  private async interruptSessionIfActive(agentId: string): Promise<boolean> {
    const core = this.coreOrThrow();
    const session = core.sessionService.getById(agentId);
    const compacting = this.isAgentCompacting(agentId);
    if (
      !session ||
      session.status === "created" ||
      (session.status === "idle" && !compacting) ||
      session.status === "stopped" ||
      session.status === "errored" ||
      session.status === "terminated"
    ) {
      return false;
    }

    const supervisor = core.supervisor;
    if (supervisor.hasWorker(agentId)) {
      core.messageService.interrupt(agentId);
      return true;
    }

    core.sessionService.applyRuntimeStatus(agentId, "idle", null, session.contextUsage);
    return true;
  }

  private isAgentCompacting(agentId: string): boolean {
    if (this.compactingAgentIds.has(agentId)) {
      return true;
    }

    return this.core?.sessionService.getById(agentId)?.status === "compacting";
  }

  private async waitForOperationCompletion(
    sessionId: string,
    operationId: string,
  ): Promise<unknown> {
    const core = this.coreOrThrow();

    return await new Promise((resolve, reject) => {
      let settled = false;

      const settle = (callback: () => void) => {
        if (settled) {
          return;
        }

        settled = true;
        clearTimeout(timeout);
        unsubscribe();
        callback();
      };

      const resolveIfCompleted = () => {
        const operation = core.operationService.getById(operationId);
        if (!operation || operation.status === "pending") {
          return false;
        }

        if (operation.status === "completed") {
          let result: unknown = {};
          if (operation.resultJson) {
            try {
              result = JSON.parse(operation.resultJson);
            } catch {
              result = operation.resultJson;
            }
          }

          settle(() => resolve(result));
          return true;
        }

        let errorMessage = `Operation ${operationId} failed.`;
        if (operation.errorJson) {
          try {
            const parsedError = JSON.parse(operation.errorJson);
            errorMessage = readString(readObject(parsedError)?.message) ?? errorMessage;
          } catch {
            errorMessage = operation.errorJson;
          }
        }

        settle(() => reject(new Error(errorMessage)));
        return true;
      };

      const unsubscribe = core.eventBus.subscribe((event) => {
        if (event.type === "operation.completed") {
          const payload = readObject(event.payload);
          if (readString(payload?.operationId) !== operationId) {
            return;
          }

          resolveIfCompleted();
          return;
        }

        if (event.sessionId !== sessionId) {
          return;
        }

        if (event.type === "session.errored") {
          const errorMessage =
            readString(readObject(readObject(event.payload)?.error)?.message) ??
            `Agent ${sessionId} errored before compaction finished.`;
          settle(() => reject(new Error(errorMessage)));
          return;
        }

        if (event.type === "session.stopped") {
          settle(() => reject(new Error(`Agent ${sessionId} stopped before compaction finished.`)));
        }
      });

      const timeout = setTimeout(() => {
        settle(() =>
          reject(new Error(`Timed out waiting for compaction to finish for ${sessionId}.`)),
        );
      }, COMPACT_OPERATION_TIMEOUT_MS);

      if (resolveIfCompleted()) {
        return;
      }
    });
  }

  private suppressExpectedShutdownErrors(): void {
    const core = this.coreOrThrow();

    for (const session of core.sessionService.list()) {
      for (const message of core.messageStore.list(session.id)) {
        const middleman = readObject(readObject(message.metadata)?.middleman);
        const event = readObject(middleman?.event);
        if (
          readString(middleman?.renderAs) === "conversation_log" &&
          readBoolean(middleman?.suppressed) !== true &&
          isExpectedShutdownErrorMessage(readString(event?.text))
        ) {
          core.messageStore.annotate(message.id, {
            middleman: {
              ...middleman,
              suppressed: true,
            },
          });
        }
      }
    }
  }

  private emitConversationMessage(event: ConversationMessageEvent): void {
    this.emit("conversation_message", event);
  }

  private emitConversationLog(event: ConversationLogEvent): void {
    this.emit("conversation_log", event);
  }

  private emitAgentMessage(event: AgentMessageEvent): void {
    this.emit("agent_message", event);
  }

  private emitAgentToolCall(event: AgentToolCallEvent): void {
    this.emit("agent_tool_call", event);
  }

  private emitStatus(
    agentId: string,
    status: AgentStatus,
    pendingCount: number,
    contextUsage?: AgentContextUsage | null,
  ): void {
    const resolvedContextUsage =
      contextUsage === undefined ? (this.getAgent(agentId)?.contextUsage ?? null) : contextUsage;
    this.emit("agent_status", {
      type: "agent_status",
      agentId,
      status,
      pendingCount,
      contextUsage: resolvedContextUsage,
    });
  }

  private emitAgentsSnapshot(): void {
    this.emit("agents_snapshot", {
      type: "agents_snapshot",
      agents: this.listAgents(),
    } satisfies AgentsSnapshotEvent);
  }

  private coreOrThrow(): SwarmdCoreHandle {
    if (!this.core) {
      throw new Error("SwarmManager has not been bootstrapped.");
    }
    return this.core;
  }

  private agentRepoOrThrow(): MiddlemanAgentRepo {
    if (!this.agentRepo) {
      throw new Error("Agent repo is not initialized.");
    }
    return this.agentRepo;
  }

  private managerOrderRepoOrThrow(): MiddlemanManagerOrderRepo {
    if (!this.managerOrderRepo) {
      throw new Error("Manager order repo is not initialized.");
    }
    return this.managerOrderRepo;
  }

  private scheduleRepoOrThrow(): MiddlemanScheduleRepo {
    if (!this.scheduleRepo) {
      throw new Error("Schedule repo is not initialized.");
    }
    return this.scheduleRepo;
  }

  private settingsRepoOrThrow(): MiddlemanSettingsRepo {
    if (!this.settingsRepo) {
      throw new Error("Settings repo is not initialized.");
    }
    return this.settingsRepo;
  }

  private secretsEnvServiceOrThrow(): SecretsEnvService {
    if (!this.secretsEnvService) {
      throw new Error("Settings service is not initialized.");
    }
    return this.secretsEnvService;
  }
}

function toContentParts(text: string, attachments: ConversationAttachment[]): ContentPart[] {
  const parts: ContentPart[] = [{ type: "text", text }];

  for (const attachment of attachments) {
    if ("filePath" in attachment && attachment.filePath) {
      parts.push({
        type: "file",
        mimeType: attachment.mimeType,
        fileName: attachment.fileName,
        path: attachment.filePath,
      });
      continue;
    }

    if (attachment.type === "text") {
      parts.push({
        type: "file",
        mimeType: attachment.mimeType,
        fileName: attachment.fileName,
        data: Buffer.from(attachment.text, "utf8").toString("base64"),
      });
      continue;
    }

    if (attachment.type === "binary") {
      parts.push({
        type: "file",
        mimeType: attachment.mimeType,
        fileName: attachment.fileName,
        data: attachment.data,
      });
      continue;
    }

    parts.push({
      type: "image",
      mimeType: attachment.mimeType,
      data: attachment.data,
    });
  }

  return parts;
}

function buildWorkerCompletionReport(
  descriptor: Pick<AgentDescriptor, "agentId">,
  history: ConversationEntryEvent[],
  lastReportedSummaryTimestamp?: string,
): { message: string; summaryTimestamp?: string } {
  const latestSummary = findLatestWorkerCompletionSummary(history);

  if (!latestSummary || latestSummary.timestamp === lastReportedSummaryTimestamp) {
    return {
      message: `SYSTEM: Worker ${descriptor.agentId} completed its turn.`,
    };
  }

  const summaryText = latestSummary.text.trim();
  const attachmentCount = latestSummary.attachments?.length ?? 0;
  const attachmentLine =
    attachmentCount > 0
      ? `\n\nAttachments: ${attachmentCount} generated attachment${attachmentCount === 1 ? "" : "s"}.`
      : "";

  if (summaryText.length > 0) {
    return {
      message:
        [
          `SYSTEM: Worker ${descriptor.agentId} completed its turn.`,
          "",
          `${latestSummary.role === "system" ? "Last system message" : "Last assistant message"}:`,
          summaryText,
        ].join("\n") + attachmentLine,
      summaryTimestamp: latestSummary.timestamp,
    };
  }

  return {
    message: `SYSTEM: Worker ${descriptor.agentId} completed its turn and generated ${attachmentCount} attachment${attachmentCount === 1 ? "" : "s"}.`,
    summaryTimestamp: latestSummary.timestamp,
  };
}

function findLatestWorkerCompletionSummary(
  history: ConversationEntryEvent[],
): ConversationMessageEvent | undefined {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const entry = history[index];
    if (entry.type !== "conversation_message") {
      continue;
    }

    if (entry.role !== "assistant" && entry.role !== "system") {
      continue;
    }

    const trimmedText = entry.text.trim();
    const attachmentCount = entry.attachments?.length ?? 0;
    if (trimmedText.length === 0 && attachmentCount === 0) {
      continue;
    }

    return entry;
  }

  return undefined;
}

function isExpectedShutdownErrorMessage(text: string | undefined): boolean {
  return (
    typeof text === "string" && /Worker exited with code null, signal (SIGINT|SIGTERM)/.test(text)
  );
}

function toSwarmdDeliveryMode(delivery?: RequestedDeliveryMode): SwarmdDeliveryMode {
  switch (delivery) {
    case "followUp":
      return "queue";
    case "steer":
      return "interrupt";
    case "auto":
    case undefined:
    default:
      return "auto";
  }
}
