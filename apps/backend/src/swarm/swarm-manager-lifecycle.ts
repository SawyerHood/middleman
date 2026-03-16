import type { SessionRecord, SwarmdCoreHandle } from "swarmd";

import { normalizeArchetypeId } from "./archetypes/archetype-prompt-registry.js";
import type {
  MiddlemanAgentRepo,
  MiddlemanAgentRow,
  MiddlemanManagerOrderRepo,
} from "./swarm-sql.js";
import type { SwarmRuntimeContextService } from "./swarm-runtime-context.js";
import type {
  AgentDescriptor,
  AgentModelDescriptor,
  AgentStatus,
  MessageTargetContext,
  SwarmConfig,
} from "./types.js";

export const MANAGER_BOOTSTRAP_INTERVIEW_MESSAGE = `You are a newly created manager agent for this user.

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

interface SwarmLifecycleServiceOptions {
  config: SwarmConfig;
  now: () => string;
  runtimeContext: SwarmRuntimeContextService;
  getCore: () => SwarmdCoreHandle;
  getAgentRepo: () => MiddlemanAgentRepo;
  getManagerOrderRepo: () => MiddlemanManagerOrderRepo;
}

export class SwarmLifecycleService {
  constructor(private readonly options: SwarmLifecycleServiceOptions) {}

  async createAgentSessionAndRow(input: {
    agentId: string;
    role: "manager" | "worker";
    managerId: string;
    archetypeId?: string;
    cwd: string;
    model: AgentModelDescriptor;
    memoryOwnerAgentId: string;
    systemPrompt?: string;
    replyTarget?: MessageTargetContext;
    preserveMiddlemanRow?: boolean;
  }): Promise<AgentDescriptor> {
    const basePrompt = input.systemPrompt?.trim() || this.options.runtimeContext.resolveSystemPromptForDescriptor({
      role: input.role,
      archetypeId: input.archetypeId,
    });
    const resources = await this.options.runtimeContext.resolveRuntimeContextResources({
      agentId: input.agentId,
      role: input.role,
      managerId: input.managerId,
      cwd: input.cwd,
      model: input.model,
      memoryOwnerAgentId: input.memoryOwnerAgentId,
    });
    const runtimeConfig = this.options.runtimeContext.buildRuntimeConfig({
      agentId: input.agentId,
      role: input.role,
      managerId: input.managerId,
      cwd: input.cwd,
      model: input.model,
      memoryOwnerAgentId: input.memoryOwnerAgentId,
    }, resources);
    const prompt = this.options.runtimeContext.buildSessionSystemPrompt(
      basePrompt,
      runtimeConfig.backend,
      resources,
    );

    this.options.getCore().sessionService.create({
      id: input.agentId,
      backend: runtimeConfig.backend,
      cwd: input.cwd,
      model: runtimeConfig.model,
      displayName: input.agentId,
      systemPrompt: prompt,
      backendConfig: runtimeConfig.backendConfig,
      autoStart: false,
    });

    if (!input.preserveMiddlemanRow) {
      this.options.getAgentRepo().create({
        sessionId: input.agentId,
        role: input.role,
        managerSessionId: input.managerId,
        archetypeId: input.archetypeId,
        memoryOwnerSessionId: input.memoryOwnerAgentId,
        replyTarget: input.replyTarget,
      });
    } else if (input.replyTarget) {
      this.options.getAgentRepo().updateReplyTarget(input.agentId, input.replyTarget);
    }

    await this.options.getCore().sessionService.start(input.agentId);
    return this.requireDescriptor(input.agentId);
  }

  async deleteAgentSession(agentId: string, options?: { preserveMiddlemanRow?: boolean }): Promise<void> {
    const session = this.options.getCore().sessionService.getById(agentId);
    if (session) {
      if (session.status !== "terminated" && session.status !== "stopped") {
        await this.terminateSession(agentId);
      }
      this.options.getCore().sessionService.delete(agentId);
    }

    if (!options?.preserveMiddlemanRow) {
      this.options.getAgentRepo().delete(agentId);
    }
  }

  async stopSession(agentId: string): Promise<void> {
    const session = this.options.getCore().sessionService.getById(agentId);
    if (!session || session.status === "stopped" || session.status === "terminated") {
      return;
    }

    await this.options.getCore().sessionService.stop(agentId);
  }

  async terminateSession(agentId: string): Promise<void> {
    const session = this.options.getCore().sessionService.getById(agentId);
    if (!session || session.status === "terminated") {
      return;
    }

    await this.options.getCore().sessionService.terminate(agentId);
  }

  async sendManagerBootstrapMessage(
    managerId: string,
    sendMessage: (fromAgentId: string, targetAgentId: string, message: string, delivery?: "auto") => Promise<unknown>,
  ): Promise<void> {
    const manager = this.getAgent(managerId);
    if (!manager || manager.role !== "manager") {
      return;
    }

    try {
      await sendMessage(managerId, managerId, MANAGER_BOOTSTRAP_INTERVIEW_MESSAGE, "auto");
    } catch {
      // Ignore bootstrap prompt failures; manager creation itself already succeeded.
    }
  }

  async ensureManagerOrder(): Promise<void> {
    this.options.getManagerOrderRepo().ensure(this.listManagers().map((manager) => manager.agentId));
  }

  resolveDefaultModelDescriptor(): AgentModelDescriptor {
    return {
      ...this.options.config.defaultModel,
    };
  }

  resolvePreferredManagerId(): string | undefined {
    const managers = this.listManagers();
    const orderedManagerIds = this.options.getManagerOrderRepo().list();
    for (const managerId of orderedManagerIds) {
      if (managers.some((manager) => manager.agentId === managerId)) {
        return managerId;
      }
    }
    return managers[0]?.agentId ?? this.options.config.managerId;
  }

  listManagers(options?: { includeArchived?: boolean }): AgentDescriptor[] {
    return this.getSortedDescriptors(options).filter((descriptor) => descriptor.role === "manager");
  }

  getSortedDescriptors(options?: { includeArchived?: boolean }): AgentDescriptor[] {
    const sessionsById = new Map(
      this.options.getCore().sessionService.list({
        includeArchived: options?.includeArchived === true,
      }).map((session) => [session.id, session]),
    );
    const descriptors = this.options.getAgentRepo()
      .list()
      .map((row) => {
        const session = sessionsById.get(row.sessionId);
        return session ? buildDescriptor(row, session) : null;
      })
      .filter((descriptor): descriptor is AgentDescriptor => descriptor !== null);

    const managerOrder = this.options.getManagerOrderRepo().list();
    const managerIndexById = new Map(managerOrder.map((managerId, index) => [managerId, index]));

    return descriptors.sort((left, right) => {
      if (left.role === "manager" && right.role === "manager") {
        return (managerIndexById.get(left.agentId) ?? Number.MAX_SAFE_INTEGER) -
          (managerIndexById.get(right.agentId) ?? Number.MAX_SAFE_INTEGER);
      }

      if (left.role === "manager") {
        return -1;
      }
      if (right.role === "manager") {
        return 1;
      }

      if (left.managerId !== right.managerId) {
        return (managerIndexById.get(left.managerId) ?? Number.MAX_SAFE_INTEGER) -
          (managerIndexById.get(right.managerId) ?? Number.MAX_SAFE_INTEGER);
      }

      if (left.createdAt !== right.createdAt) {
        return left.createdAt.localeCompare(right.createdAt);
      }

      return left.agentId.localeCompare(right.agentId);
    });
  }

  getAgent(agentId: string): AgentDescriptor | undefined {
    return this.getSortedDescriptors().find((descriptor) => descriptor.agentId === agentId);
  }

  requireDescriptor(agentId: string): AgentDescriptor {
    const descriptor = this.getAgent(agentId);
    if (!descriptor) {
      throw new Error(`Unknown agent: ${agentId}`);
    }
    return descriptor;
  }

  assertManager(agentId: string, action: string): AgentDescriptor {
    const descriptor = this.requireDescriptor(agentId);
    if (descriptor.role !== "manager") {
      throw new Error(`Only managers can ${action}.`);
    }
    return descriptor;
  }

  generateUniqueManagerId(name: string): string {
    return this.generateUniqueAgentId(name.trim().replace(/\s+/g, "-"));
  }

  generateUniqueAgentId(candidate: string): string {
    const base = normalizeArchetypeId(candidate) || "agent";
    const existing = new Set(
      this.getSortedDescriptors({ includeArchived: true }).map((agent) => agent.agentId),
    );
    if (!existing.has(base)) {
      return base;
    }

    let index = 2;
    while (existing.has(`${base}-${index}`)) {
      index += 1;
    }

    return `${base}-${index}`;
  }

  resolveSpawnWorkerArchetypeId(archetypeId?: string): string | undefined {
    if (!archetypeId?.trim()) {
      return undefined;
    }
    return normalizeArchetypeId(archetypeId);
  }
}

function buildDescriptor(agentRow: MiddlemanAgentRow, session: SessionRecord): AgentDescriptor {
  return {
    agentId: agentRow.sessionId,
    displayName: session.displayName,
    role: agentRow.role,
    managerId: agentRow.managerSessionId,
    archetypeId: agentRow.archetypeId,
    status: session.status as AgentStatus,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    cwd: session.cwd,
    model: fromSwarmdModel(session),
    contextUsage: session.contextUsage ?? undefined,
  };
}

function fromSwarmdModel(session: SessionRecord): AgentModelDescriptor {
  if (session.backend === "codex") {
    return {
      provider: "openai-codex-app-server",
      modelId: session.model,
      thinkingLevel: "xhigh",
    };
  }

  if (session.backend === "claude") {
    return {
      provider: "anthropic-claude-code",
      modelId: session.model,
      thinkingLevel: "xhigh",
    };
  }

  const parsedModel = /^([^/:]+)[/:](.+)$/.exec(session.model);
  return {
    provider: parsedModel?.[1] ?? "openai-codex",
    modelId: parsedModel?.[2] ?? session.model,
    thinkingLevel: "xhigh",
  };
}
