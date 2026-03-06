import { delimiter, resolve } from "node:path";
import { getModel, type Model } from "@mariozechner/pi-ai";
import {
  AuthStorage,
  DefaultResourceLoader,
  createCodingTools,
  createAgentSession,
  ModelRegistry,
  SessionManager,
  type AgentSession,
  type BashSpawnContext
} from "@mariozechner/pi-coding-agent";
import { AgentRuntime } from "./agent-runtime.js";
import { ClaudeCodeRuntime } from "./claude-code-runtime.js";
import { CodexAgentRuntime } from "./codex-agent-runtime.js";
import type { RuntimeErrorEvent, RuntimeSessionEvent, SwarmAgentRuntime } from "./runtime-types.js";
import { buildSwarmTools, type SwarmToolHost } from "./swarm-tools.js";
import type {
  AgentContextUsage,
  AgentDescriptor,
  AgentModelDescriptor,
  AgentStatus,
  SwarmConfig
} from "./types.js";

interface RuntimeFactoryDependencies {
  host: SwarmToolHost;
  config: SwarmConfig;
  now: () => string;
  logDebug: (message: string, details?: unknown) => void;
  getMemoryRuntimeResources: (descriptor: AgentDescriptor) => Promise<{
    memoryContextFile: { path: string; content: string };
    additionalSkillPaths: string[];
  }>;
  getSwarmContextFiles: (cwd: string) => Promise<Array<{ path: string; content: string }>>;
  mergeRuntimeContextFiles: (
    baseAgentsFiles: Array<{ path: string; content: string }>,
    options: {
      memoryContextFile: { path: string; content: string };
      swarmContextFiles: Array<{ path: string; content: string }>;
    }
  ) => Array<{ path: string; content: string }>;
  callbacks: {
    onStatusChange: (
      agentId: string,
      status: AgentStatus,
      pendingCount: number,
      contextUsage?: AgentContextUsage
    ) => Promise<void>;
    onSessionEvent: (agentId: string, event: RuntimeSessionEvent) => Promise<void>;
    onAgentEnd: (agentId: string) => Promise<void>;
    onRuntimeError: (agentId: string, error: RuntimeErrorEvent) => Promise<void>;
  };
}

export class RuntimeFactory {
  constructor(private readonly deps: RuntimeFactoryDependencies) {}

  async createRuntimeForDescriptor(
    descriptor: AgentDescriptor,
    systemPrompt: string
  ): Promise<SwarmAgentRuntime> {
    if (isClaudeCodeModelDescriptor(descriptor.model)) {
      return this.createClaudeCodeRuntimeForDescriptor(descriptor, systemPrompt);
    }

    if (isCodexAppServerModelDescriptor(descriptor.model)) {
      return this.createCodexRuntimeForDescriptor(descriptor, systemPrompt);
    }

    return this.createPiRuntimeForDescriptor(descriptor, systemPrompt);
  }

  private async createPiRuntimeForDescriptor(
    descriptor: AgentDescriptor,
    systemPrompt: string
  ): Promise<SwarmAgentRuntime> {
    const swarmTools = buildSwarmTools(this.deps.host, descriptor);
    const thinkingLevel = normalizeThinkingLevel(descriptor.model.thinkingLevel);
    const runtimeAgentDir =
      descriptor.role === "manager" ? this.deps.config.paths.managerAgentDir : this.deps.config.paths.agentDir;
    const memoryResources = await this.deps.getMemoryRuntimeResources(descriptor);

    this.deps.logDebug("runtime:create:start", {
      runtime: "pi",
      agentId: descriptor.agentId,
      role: descriptor.role,
      model: descriptor.model,
      archetypeId: descriptor.archetypeId,
      cwd: descriptor.cwd,
      authFile: this.deps.config.paths.authFile,
      agentDir: runtimeAgentDir,
      memoryFile: memoryResources.memoryContextFile.path,
      managerSystemPromptSource:
        descriptor.role === "manager" ? "archetype:manager" : undefined
    });

    const authStorage = AuthStorage.create(this.deps.config.paths.authFile);
    const modelRegistry = new ModelRegistry(authStorage);
    const swarmContextFiles = await this.deps.getSwarmContextFiles(descriptor.cwd);
    const applyRuntimeContext = (base: { agentsFiles: Array<{ path: string; content: string }> }) => ({
      agentsFiles: this.deps.mergeRuntimeContextFiles(base.agentsFiles, {
        memoryContextFile: memoryResources.memoryContextFile,
        swarmContextFiles
      })
    });
    const runtimeEnv = this.buildAgentRuntimeEnv(descriptor, memoryResources.memoryContextFile.path);
    const codingTools = createCodingTools(descriptor.cwd, {
      bash: {
        spawnHook: (context: BashSpawnContext): BashSpawnContext => ({
          ...context,
          env: {
            ...context.env,
            ...runtimeEnv
          }
        })
      }
    });

    const resourceLoader =
      descriptor.role === "manager"
        ? new DefaultResourceLoader({
            cwd: descriptor.cwd,
            agentDir: runtimeAgentDir,
            additionalSkillPaths: memoryResources.additionalSkillPaths,
            agentsFilesOverride: applyRuntimeContext,
            // Manager prompt comes from the archetype prompt registry.
            systemPrompt,
            appendSystemPromptOverride: () => []
          })
        : new DefaultResourceLoader({
            cwd: descriptor.cwd,
            agentDir: runtimeAgentDir,
            additionalSkillPaths: memoryResources.additionalSkillPaths,
            agentsFilesOverride: applyRuntimeContext,
            appendSystemPromptOverride: (base) => [...base, systemPrompt]
          });
    await resourceLoader.reload();

    const model = this.resolveModel(modelRegistry, descriptor.model);
    if (!model) {
      throw new Error(
        `Unable to resolve model ${descriptor.model.provider}/${descriptor.model.modelId}. ` +
          "Install a model supported by @mariozechner/pi-ai."
      );
    }

    const { session } = await createAgentSession({
      cwd: descriptor.cwd,
      agentDir: runtimeAgentDir,
      authStorage,
      modelRegistry,
      model,
      thinkingLevel: thinkingLevel as any,
      tools: codingTools,
      sessionManager: SessionManager.open(descriptor.sessionFile),
      resourceLoader,
      customTools: swarmTools
    });

    const activeToolNames = new Set(session.getActiveToolNames());
    for (const tool of swarmTools) {
      activeToolNames.add(tool.name);
    }
    session.setActiveToolsByName(Array.from(activeToolNames));

    this.deps.logDebug("runtime:create:ready", {
      runtime: "pi",
      agentId: descriptor.agentId,
      activeTools: session.getActiveToolNames(),
      systemPromptPreview: previewForLog(session.systemPrompt, 240),
      containsSpeakToUserRule:
        descriptor.role === "manager" ? session.systemPrompt.includes("speak_to_user") : undefined
    });

    return new AgentRuntime({
      descriptor,
      session: session as AgentSession,
      callbacks: {
        onStatusChange: async (agentId, status, pendingCount, contextUsage) => {
          await this.deps.callbacks.onStatusChange(agentId, status, pendingCount, contextUsage);
        },
        onSessionEvent: async (agentId, event) => {
          await this.deps.callbacks.onSessionEvent(agentId, event);
        },
        onAgentEnd: async (agentId) => {
          await this.deps.callbacks.onAgentEnd(agentId);
        },
        onRuntimeError: async (agentId, error) => {
          await this.deps.callbacks.onRuntimeError(agentId, error);
        }
      },
      now: this.deps.now
    });
  }

  private async createCodexRuntimeForDescriptor(
    descriptor: AgentDescriptor,
    systemPrompt: string
  ): Promise<SwarmAgentRuntime> {
    const swarmTools = buildSwarmTools(this.deps.host, descriptor);
    const memoryResources = await this.deps.getMemoryRuntimeResources(descriptor);
    const swarmContextFiles = await this.deps.getSwarmContextFiles(descriptor.cwd);

    const codexSystemPrompt = this.buildCodexRuntimeSystemPrompt(systemPrompt, {
      memoryContextFile: memoryResources.memoryContextFile,
      swarmContextFiles
    });

    this.deps.logDebug("runtime:create:start", {
      runtime: "codex-app-server",
      agentId: descriptor.agentId,
      role: descriptor.role,
      model: descriptor.model,
      archetypeId: descriptor.archetypeId,
      cwd: descriptor.cwd
    });

    const runtime = await CodexAgentRuntime.create({
      descriptor,
      callbacks: {
        onStatusChange: async (agentId, status, pendingCount, contextUsage) => {
          await this.deps.callbacks.onStatusChange(agentId, status, pendingCount, contextUsage);
        },
        onSessionEvent: async (agentId, event) => {
          await this.deps.callbacks.onSessionEvent(agentId, event);
        },
        onAgentEnd: async (agentId) => {
          await this.deps.callbacks.onAgentEnd(agentId);
        },
        onRuntimeError: async (agentId, error) => {
          await this.deps.callbacks.onRuntimeError(agentId, error);
        }
      },
      now: this.deps.now,
      systemPrompt: codexSystemPrompt,
      tools: swarmTools,
      runtimeEnv: this.buildAgentRuntimeEnv(descriptor, memoryResources.memoryContextFile.path)
    });

    this.deps.logDebug("runtime:create:ready", {
      runtime: "codex-app-server",
      agentId: descriptor.agentId,
      activeTools: swarmTools.map((tool) => tool.name),
      systemPromptPreview: previewForLog(codexSystemPrompt, 240)
    });

    return runtime;
  }

  private async createClaudeCodeRuntimeForDescriptor(
    descriptor: AgentDescriptor,
    systemPrompt: string
  ): Promise<SwarmAgentRuntime> {
    const swarmTools = buildSwarmTools(this.deps.host, descriptor);
    const memoryResources = await this.deps.getMemoryRuntimeResources(descriptor);
    const swarmContextFiles = await this.deps.getSwarmContextFiles(descriptor.cwd);

    const claudeCodeSystemPrompt = this.buildCodexRuntimeSystemPrompt(systemPrompt, {
      memoryContextFile: memoryResources.memoryContextFile,
      swarmContextFiles
    });

    this.deps.logDebug("runtime:create:start", {
      runtime: "anthropic-claude-code",
      agentId: descriptor.agentId,
      role: descriptor.role,
      model: descriptor.model,
      archetypeId: descriptor.archetypeId,
      cwd: descriptor.cwd
    });

    const runtime = await ClaudeCodeRuntime.create({
      descriptor,
      callbacks: {
        onStatusChange: async (agentId, status, pendingCount, contextUsage) => {
          await this.deps.callbacks.onStatusChange(agentId, status, pendingCount, contextUsage);
        },
        onSessionEvent: async (agentId, event) => {
          await this.deps.callbacks.onSessionEvent(agentId, event);
        },
        onAgentEnd: async (agentId) => {
          await this.deps.callbacks.onAgentEnd(agentId);
        },
        onRuntimeError: async (agentId, error) => {
          await this.deps.callbacks.onRuntimeError(agentId, error);
        }
      },
      now: this.deps.now,
      systemPrompt: claudeCodeSystemPrompt,
      tools: swarmTools,
      runtimeEnv: this.buildAgentRuntimeEnv(descriptor, memoryResources.memoryContextFile.path)
    });

    this.deps.logDebug("runtime:create:ready", {
      runtime: "anthropic-claude-code",
      agentId: descriptor.agentId,
      activeTools: swarmTools.map((tool) => tool.name),
      systemPromptPreview: previewForLog(claudeCodeSystemPrompt, 240)
    });

    return runtime;
  }

  private buildCodexRuntimeSystemPrompt(
    baseSystemPrompt: string,
    options: {
      memoryContextFile: { path: string; content: string };
      swarmContextFiles: Array<{ path: string; content: string }>;
    }
  ): string {
    const sections: string[] = [];

    const trimmedBase = baseSystemPrompt.trim();
    if (trimmedBase.length > 0) {
      sections.push(trimmedBase);
    }

    for (const contextFile of options.swarmContextFiles) {
      const content = contextFile.content.trim();
      if (!content) {
        continue;
      }

      sections.push(
        [
          `Repository swarm policy (${contextFile.path}):`,
          "----- BEGIN SWARM CONTEXT -----",
          content,
          "----- END SWARM CONTEXT -----"
        ].join("\n")
      );
    }

    const memoryContent = options.memoryContextFile.content.trim();
    if (memoryContent) {
      sections.push(
        [
          `Persistent swarm memory (${options.memoryContextFile.path}):`,
          "----- BEGIN SWARM MEMORY -----",
          memoryContent,
          "----- END SWARM MEMORY -----"
        ].join("\n")
      );
    }

    return sections.join("\n\n");
  }

  private resolveModel(modelRegistry: ModelRegistry, descriptor: AgentModelDescriptor): Model<any> | undefined {
    const direct = modelRegistry.find(descriptor.provider, descriptor.modelId);
    if (direct) return direct;

    const fromCatalog = getModel(descriptor.provider as any, descriptor.modelId as any);
    if (fromCatalog) return fromCatalog;

    return modelRegistry.getAll()[0];
  }

  private buildAgentRuntimeEnv(
    descriptor: AgentDescriptor,
    memoryFilePath: string
  ): Record<string, string | undefined> {
    const cliBinDir = resolve(this.deps.config.paths.rootDir, "apps", "cli", "bin");
    const workspaceBinDir = resolve(this.deps.config.paths.rootDir, "node_modules", ".bin");
    const prefixedPath = [cliBinDir, workspaceBinDir, process.env.PATH ?? ""]
      .filter((entry) => entry.length > 0)
      .join(delimiter);

    return {
      SWARM_DATA_DIR: this.deps.config.paths.dataDir,
      SWARM_MEMORY_FILE: memoryFilePath,
      MIDDLEMAN_AGENT_ID: descriptor.agentId,
      MIDDLEMAN_API_BASE_URL: `http://${this.deps.config.host}:${this.deps.config.port}`,
      PATH: prefixedPath
    };
  }
}

function isCodexAppServerModelDescriptor(descriptor: Pick<AgentModelDescriptor, "provider">): boolean {
  return descriptor.provider.trim().toLowerCase() === "openai-codex-app-server";
}

function isClaudeCodeModelDescriptor(descriptor: Pick<AgentModelDescriptor, "provider">): boolean {
  return descriptor.provider.trim().toLowerCase() === "anthropic-claude-code";
}

function normalizeThinkingLevel(level: string): string {
  return level === "x-high" ? "xhigh" : level;
}

function previewForLog(text: string, maxLength = 160): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength)}...`;
}
