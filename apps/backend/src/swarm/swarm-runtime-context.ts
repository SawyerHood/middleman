import { mkdir, readFile, writeFile } from "node:fs/promises";
import { delimiter, dirname, join, resolve } from "node:path";

import { getAgentMemoryPath } from "./memory-paths.js";
import {
  DEFAULT_SWARM_MODEL_PRESET,
  inferSwarmModelPresetFromDescriptor,
} from "./model-presets.js";
import { validateDirectoryPath } from "./cwd-policy.js";
import type { ArchetypePromptRegistry } from "./archetypes/archetype-prompt-registry.js";
import { SkillMetadataService } from "./skill-metadata-service.js";
import { type MiddlemanSettingsRepo } from "./swarm-sql.js";
import type { AgentDescriptor, AgentModelDescriptor, SwarmConfig } from "./types.js";

export const DEFAULT_WORKER_SYSTEM_PROMPT = `You are a worker agent in a swarm.
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
- Follow the memory skill workflow before editing the memory file, and never store secrets in memory.
- When creating reports, audits, or other output files, write them to \${SWARM_NOTES_DIR} so they appear in the manager's Notes panel.`;

export const MANAGER_ARCHETYPE_ID = "manager";
const SWARM_CONTEXT_FILE_NAME = "SWARM.md";

export interface RuntimeContextFile {
  path: string;
  content: string;
}

export interface RuntimeSkillDescriptor {
  skillName: string;
  description?: string;
  path: string;
}

export interface RuntimeContextResources {
  memoryContextFile: RuntimeContextFile;
  swarmContextFiles: RuntimeContextFile[];
  skillDescriptors: RuntimeSkillDescriptor[];
  additionalSkillPaths: string[];
  runtimeEnv: Record<string, string | undefined>;
}

interface SwarmRuntimeContextServiceOptions {
  config: SwarmConfig;
  cwdAllowlistRoots: string[];
  skillMetadataService: SkillMetadataService;
  getArchetypePromptRegistry: () => ArchetypePromptRegistry;
  getSettingsRepo: () => MiddlemanSettingsRepo;
  listAgents: () => AgentDescriptor[];
}

export class SwarmRuntimeContextService {
  constructor(private readonly options: SwarmRuntimeContextServiceOptions) {}

  resolveSystemPromptForDescriptor(
    descriptor: Pick<AgentDescriptor, "role" | "archetypeId">,
  ): string {
    const registry = this.options.getArchetypePromptRegistry();
    let prompt: string | undefined;
    if (descriptor.archetypeId) {
      prompt = registry.resolvePrompt(descriptor.archetypeId);
    }

    if (!prompt && descriptor.role === "manager") {
      prompt = registry.resolvePrompt(MANAGER_ARCHETYPE_ID) ?? DEFAULT_WORKER_SYSTEM_PROMPT;
    }

    if (!prompt) {
      prompt = DEFAULT_WORKER_SYSTEM_PROMPT;
    }

    if (descriptor.role !== "manager") {
      return prompt;
    }

    const availableArchetypeIds = registry.listArchetypeIds();
    if (availableArchetypeIds.length === 0) {
      return prompt;
    }

    return [
      prompt.trim(),
      `Available archetypes for spawn_agent: ${availableArchetypeIds.join(", ")}`,
    ].join("\n\n");
  }

  async resolveAndValidateCwd(cwd: string): Promise<string> {
    return await validateDirectoryPath(cwd, {
      rootDir: this.options.config.defaultCwd,
      allowlistRoots: this.options.cwdAllowlistRoots,
    });
  }

  async ensureDirectories(): Promise<void> {
    for (const dir of [
      this.options.config.paths.dataDir,
      this.options.config.paths.runDir,
      this.options.config.paths.logsDir,
      this.options.config.paths.uploadsDir,
      this.options.config.paths.authDir,
      this.options.config.paths.memoryDir,
      this.options.config.paths.runtimeScratchDir,
    ]) {
      await mkdir(dir, { recursive: true });
    }
  }

  async ensureMemoryFilesForAgents(): Promise<void> {
    for (const agent of this.options.listAgents()) {
      await this.ensureMemoryFile(agent.role === "manager" ? agent.agentId : agent.managerId);
    }
  }

  async ensureMemoryFile(agentId: string): Promise<void> {
    const memoryPath = getAgentMemoryPath(this.options.config.paths.dataDir, agentId);

    try {
      await readFile(memoryPath, "utf8");
    } catch {
      await mkdir(dirname(memoryPath), { recursive: true });
      await writeFile(memoryPath, "", "utf8");
    }
  }

  async resolveRuntimeContextResources(input: {
    agentId: string;
    role: "manager" | "worker";
    managerId: string;
    cwd: string;
    model: AgentModelDescriptor;
    memoryOwnerAgentId: string;
  }): Promise<RuntimeContextResources> {
    await this.ensureMemoryFile(input.memoryOwnerAgentId);
    await this.options.skillMetadataService.ensureSkillMetadataLoaded();

    const memoryPath = getAgentMemoryPath(
      this.options.config.paths.dataDir,
      input.memoryOwnerAgentId,
    );
    const [memoryContent, swarmContextFiles] = await Promise.all([
      readFile(memoryPath, "utf8"),
      this.getSwarmContextFiles(input.cwd),
    ]);

    return {
      memoryContextFile: {
        path: memoryPath,
        content: memoryContent,
      },
      swarmContextFiles,
      skillDescriptors: this.options.skillMetadataService.getSkillMetadata().map((skill) => ({
        skillName: skill.skillName,
        description: skill.description,
        path: skill.path,
      })),
      additionalSkillPaths: this.options.skillMetadataService.getAdditionalSkillPaths(),
      runtimeEnv: this.buildAgentRuntimeEnv({
        ...input,
        memoryFilePath: memoryPath,
      }),
    };
  }

  buildRuntimeConfig(
    descriptor: {
      agentId: string;
      role: "manager" | "worker";
      managerId: string;
      cwd: string;
      model: AgentModelDescriptor;
      memoryOwnerAgentId: string;
    },
    resources: RuntimeContextResources,
  ): {
    backend: "codex" | "claude" | "pi";
    model: string;
    backendConfig: Record<string, unknown>;
  } {
    const preset =
      inferSwarmModelPresetFromDescriptor(descriptor.model) ?? DEFAULT_SWARM_MODEL_PRESET;
    const commonMiddleman = {
      role: descriptor.role,
    };

    switch (preset) {
      case "codex-app":
      case "codex-app-mini":
        return {
          backend: "codex",
          model: descriptor.model.modelId,
          backendConfig: {
            middleman: commonMiddleman,
            thinkingLevel: descriptor.model.thinkingLevel,
            env: resources.runtimeEnv,
            approvalPolicy: "never",
            sandbox: "danger-full-access",
            ...resolveMockRuntimeConfigFromEnv(),
          },
        };
      case "claude-code":
      case "claude-code-sonnet":
      case "claude-code-haiku":
        return {
          backend: "claude",
          model: descriptor.model.modelId,
          backendConfig: {
            middleman: commonMiddleman,
            thinkingLevel: descriptor.model.thinkingLevel,
            env: resources.runtimeEnv,
            ...resolveMockRuntimeConfigFromEnv(),
          },
        };
      case "pi-opus":
      case "pi-sonnet":
      case "pi-haiku":
      case "pi-codex":
      case "pi-codex-mini":
      default:
        return {
          backend: "pi",
          model: `${descriptor.model.provider}/${descriptor.model.modelId}`,
          backendConfig: {
            middleman: commonMiddleman,
            thinkingLevel: descriptor.model.thinkingLevel,
            env: resources.runtimeEnv,
            authFile: this.options.config.paths.authFile,
            memoryContextFile: resources.memoryContextFile,
            swarmContextFiles: resources.swarmContextFiles,
            additionalSkillPaths: resources.additionalSkillPaths,
            modelProvider: descriptor.model.provider,
            modelId: descriptor.model.modelId,
            agentDir: join(
              this.options.config.paths.runtimeScratchDir,
              descriptor.agentId,
              "agent",
            ),
            sessionDir: join(
              this.options.config.paths.runtimeScratchDir,
              descriptor.agentId,
              "sessions",
            ),
            ...resolveMockRuntimeConfigFromEnv(),
          },
        };
    }
  }

  buildSessionSystemPrompt(
    baseSystemPrompt: string,
    backend: "codex" | "claude" | "pi",
    resources: RuntimeContextResources,
  ): string {
    if (backend === "pi") {
      return baseSystemPrompt;
    }

    const sections: string[] = [];
    const trimmedBase = baseSystemPrompt.trim();
    if (trimmedBase.length > 0) {
      sections.push(trimmedBase);
    }

    for (const contextFile of resources.swarmContextFiles) {
      const content = contextFile.content.trim();
      if (!content) {
        continue;
      }

      sections.push(
        [
          `Repository swarm policy (${contextFile.path}):`,
          "----- BEGIN SWARM CONTEXT -----",
          content,
          "----- END SWARM CONTEXT -----",
        ].join("\n"),
      );
    }

    const memoryContent = resources.memoryContextFile.content.trim();
    if (memoryContent) {
      sections.push(
        [
          `Persistent swarm memory (${resources.memoryContextFile.path}):`,
          "----- BEGIN SWARM MEMORY -----",
          memoryContent,
          "----- END SWARM MEMORY -----",
        ].join("\n"),
      );
    }

    if (resources.skillDescriptors.length > 0) {
      sections.push(
        [
          "<available_skills>",
          ...resources.skillDescriptors.map((skill) => {
            const description = skill.description?.trim() || "No description provided.";
            return `- ${skill.skillName}: ${description} (file: ${skill.path})`;
          }),
          "</available_skills>",
        ].join("\n"),
      );
    }

    return sections.join("\n\n");
  }

  private async getSwarmContextFiles(cwd: string): Promise<RuntimeContextFile[]> {
    const contextFiles: RuntimeContextFile[] = [];
    const seenPaths = new Set<string>();
    const rootDir = resolve("/");
    let currentDir = resolve(cwd);

    while (true) {
      const candidatePath = join(currentDir, SWARM_CONTEXT_FILE_NAME);
      if (!seenPaths.has(candidatePath)) {
        try {
          contextFiles.unshift({
            path: candidatePath,
            content: await readFile(candidatePath, "utf8"),
          });
          seenPaths.add(candidatePath);
        } catch (error) {
          if (
            !(
              error &&
              typeof error === "object" &&
              "code" in error &&
              (error as { code?: string }).code === "ENOENT"
            )
          ) {
            throw error;
          }
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
  private buildAgentRuntimeEnv(input: {
    agentId: string;
    managerId: string;
    memoryOwnerAgentId: string;
    memoryFilePath: string;
  }): Record<string, string | undefined> {
    const workspaceBinDir = resolve(this.options.config.paths.installDir, "node_modules", ".bin");
    const parentWorkspaceBinDir = resolve(this.options.config.paths.installDir, "..", ".bin");
    const prefixedPath = [
      this.options.config.paths.cliBinDir,
      workspaceBinDir,
      parentWorkspaceBinDir,
      process.env.PATH ?? "",
    ]
      .filter((entry) => entry.length > 0)
      .join(delimiter);

    return {
      ...this.options.getSettingsRepo().listEnv(),
      MIDDLEMAN_HOME: this.options.config.paths.dataDir,
      MIDDLEMAN_INSTALL_DIR: this.options.config.paths.installDir,
      MIDDLEMAN_PROJECT_ROOT: this.options.config.paths.projectRoot,
      MIDDLEMAN_AGENT_ID: input.agentId,
      MIDDLEMAN_MANAGER_ID: input.managerId,
      MIDDLEMAN_API_BASE_URL: `http://${this.options.config.host}:${this.options.config.port}`,
      SWARM_DATA_DIR: this.options.config.paths.dataDir,
      SWARM_NOTES_DIR: join(this.options.config.paths.dataDir, "notes", input.managerId),
      SWARM_MEMORY_FILE: input.memoryFilePath,
      SWARM_MANAGER_MEMORY_FILE: getAgentMemoryPath(
        this.options.config.paths.dataDir,
        input.managerId,
      ),
      PATH: prefixedPath,
    };
  }
}

function resolveMockRuntimeConfigFromEnv(): Record<string, unknown> {
  const fixtureFile = process.env.MIDDLEMAN_E2E_RUNTIME_FIXTURE?.trim();
  if (!fixtureFile) {
    return {};
  }

  const scenarioId = process.env.MIDDLEMAN_E2E_RUNTIME_SCENARIO?.trim();
  return {
    mockRuntime: {
      fixtureFile,
      ...(scenarioId ? { scenarioId } : {}),
    },
  };
}
